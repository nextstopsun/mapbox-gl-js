// @flow

import { bindAll } from './util';
import { serialize, deserialize } from './web_worker_transfer';

import type {Transferable} from '../types/transferable';
import type {Cancelable} from '../types/cancelable';

/**
 * An implementation of the [Actor design pattern](http://en.wikipedia.org/wiki/Actor_model)
 * that maintains the relationship between asynchronous tasks and the objects
 * that spin them off - in this case, tasks like parsing parts of styles,
 * owned by the styles
 *
 * @param {WebWorker} target
 * @param {WebWorker} parent
 * @param {string|number} mapId A unique identifier for the Map instance using this Actor.
 * @private
 */
class Actor {
    target: any;
    parent: any;
    mapId: ?number;
    callbacks: { number: any };
    name: string;
    tasks: { number: any };
    taskQueue: Array<number>;
    cancelCallbacks: { number: Cancelable };
    taskTimeout: ?TimeoutID;

    static taskId: number;

    constructor(target: any, parent: any, mapId: ?number) {
        this.target = target;
        this.parent = parent;
        this.mapId = mapId;
        this.callbacks = {};
        this.tasks = {};
        this.taskQueue = [];
        this.taskTimeout = null;
        this.cancelCallbacks = {};
        bindAll(['receive', 'process'], this);
        this.target.addEventListener('message', this.receive, false);
    }

    /**
     * Sends a message from a main-thread map to a Worker or from a Worker back to
     * a main-thread map instance.
     *
     * @param type The name of the target method to invoke or '[source-type].[source-name].name' for a method on a WorkerSource.
     * @param targetMapId A particular mapId to which to send this message.
     * @private
     */
    send(type: string, data: mixed, callback: ?Function, targetMapId: ?string): ?Cancelable {
        const id = ++Actor.taskId;
        if (callback) {
            this.callbacks[id] = callback;
        }
        const buffers: Array<Transferable> = [];
        this.target.postMessage({
            id,
            type,
            hasCallback: !!callback,
            targetMapId,
            sourceMapId: this.mapId,
            data: serialize(data, buffers)
        }, buffers);
        return {
            cancel: () => {
                if (callback) {
                    // Set the callback to null so that it never fires after the request is aborted.
                    delete this.callbacks[id];
                }
                this.target.postMessage({
                    id,
                    type: '<cancel>',
                    targetMapId,
                    sourceMapId: this.mapId
                });
            }
        };
    }

    receive(message: Object) {
        const data = message.data,
            id = data.id;

        if (!id) {
            return;
        }

        if (data.targetMapId && this.mapId !== data.targetMapId) {
            return;
        }

        if (data.type === '<cancel>') {
            // Remove the original request from the queue. This is only possible if it
            // hasn't been kicked off yet. The id will remain in the queue, but because
            // there is no associated task, it will be dropped once it's time to execute it.
            delete this.tasks[id];
            const cancel = this.cancelCallbacks[id];
            delete this.cancelCallbacks[id];
            if (cancel) {
                cancel();
            }
        } else {
            // Store the tasks that we need to process before actually processing them. This
            // is necessary because we want to keep receiving messages, and in particular,
            // <cancel> messages. Some tasks may take a while in the worker thread, so before
            // executing the next task in our queue, postMessage preempts this and <cancel>
            // messages can be processed.
            this.tasks[id] = data;
            this.taskQueue.push(id);
            if (!this.taskTimeout) {
                this.taskTimeout = setTimeout(this.process, 0);
            }
        }
    }

    process() {
        // Reset the timeout ID so that we know that no process call is scheduled in the future yet.
        this.taskTimeout = null;
        if (!this.taskQueue.length) {
            return;
        }
        const id = this.taskQueue.shift();
        const task = this.tasks[id];
        delete this.tasks[id];
        // Schedule another process call if we know there's more to process _before_ invoking the
        // current task. This is necessary so that processing continues even if the current task
        // doesn't execute successfully.
        if (this.taskQueue.length) {
            this.taskTimeout = setTimeout(this.process, 0);
        }
        if (!task) {
            // If the task ID doesn't have associated task data anymore, it was canceled.
            return;
        }

        if (task.type === '<response>') {
            // The done() function in the counterpart has been called, and we are now
            // firing the callback in the originating actor, if there is one.
            const callback = this.callbacks[id];
            delete this.callbacks[id];
            if (callback) {
                // If we get a response, but don't have a callback, the request was canceled.
                if (task.error) {
                    callback(deserialize(task.error));
                } else {
                    callback(null, deserialize(task.data));
                }
            }
        } else {
            let completed = false;
            const done = task.hasCallback ? (err, data) => {
                completed = true;
                delete this.cancelCallbacks[id];
                const buffers: Array<Transferable> = [];
                this.target.postMessage({
                    id,
                    type: '<response>',
                    sourceMapId: this.mapId,
                    error: err ? serialize(err) : null,
                    data: serialize(data, buffers)
                }, buffers);
            } : (_) => {
                completed = true;
            };

            let callback = null;
            const params = (deserialize(task.data): any);
            if (this.parent[task.type]) {
                // task.type == 'loadTile', 'removeTile', etc.
                callback = this.parent[task.type](task.sourceMapId, params, done);
            } else if (this.parent.getWorkerSource) {
                // task.type == sourcetype.method
                const keys = task.type.split('.');
                const scope = (this.parent: any).getWorkerSource(task.sourceMapId, keys[0], params.source);
                callback = scope[keys[1]](params, done);
            } else {
                // No function was found.
                done(new Error(`Could not find function ${task.type}`));
            }

            if (!completed && callback && callback.cancel) {
                // Allows canceling the task as long as it hasn't been completed yet.
                this.cancelCallbacks[id] = callback.cancel;
            }
        }
    }

    remove() {
        this.target.removeEventListener('message', this.receive, false);
    }
}

Actor.taskId = 0;

export default Actor;
