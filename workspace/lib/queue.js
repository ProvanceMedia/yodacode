// Per-conversation serial queue. Slack events for the same conversation
// (channel + threadTs) are processed one at a time. Events arriving while a
// reply is in flight are coalesced — the worker will pick up the most recent
// state when it next runs.

import { logger } from './logger.js';

class Queue {
  constructor() {
    /** @type {Map<string, { running: boolean, pending: object|null }>} */
    this.lanes = new Map();
  }

  /**
   * Submit an event for processing. If the lane is idle, the worker runs
   * immediately. If a worker is already running for that lane, the new event
   * replaces any pending event (we only care about the most recent state).
   *
   * @param {string} key  Conversation key (e.g. "C123:1234.5678")
   * @param {object} event Slack event
   * @param {(event: object) => Promise<void>} worker
   */
  submit(key, event, worker) {
    let lane = this.lanes.get(key);
    if (!lane) {
      lane = { running: false, pending: null };
      this.lanes.set(key, lane);
    }

    if (lane.running) {
      // A worker is already running. Coalesce: keep the latest event for the
      // worker to pick up after the current run finishes.
      lane.pending = event;
      logger.debug('queue: coalesced into pending', { key });
      return;
    }

    lane.running = true;
    this._runLane(key, event, worker).catch((err) => {
      logger.error('queue: worker threw', { key, err: err.message, stack: err.stack });
    });
  }

  async _runLane(key, event, worker) {
    const lane = this.lanes.get(key);
    let current = event;
    while (current) {
      try {
        await worker(current);
      } catch (err) {
        logger.error('queue: worker error', { key, err: err.message });
      }
      current = lane.pending;
      lane.pending = null;
    }
    lane.running = false;
    // Clean up empty lanes to avoid unbounded Map growth
    if (!lane.pending) this.lanes.delete(key);
  }

  /** How many lanes have a worker running right now */
  activeCount() {
    let n = 0;
    for (const lane of this.lanes.values()) if (lane.running) n++;
    return n;
  }
}

export const queue = new Queue();

export function laneKey(channel, threadTs) {
  return `${channel}:${threadTs || 'top'}`;
}
