/**
 * 进程内事件总线：代理层写完一条日志后广播，供 /admin/api/events (SSE)
 * 实时推送给 Web 控制台，实现「实时日志」面板。
 */
import { EventEmitter } from 'node:events';

export const EVENTS = {
  LOG: 'log',
  UPSTREAM_CHANGED: 'upstream-changed',
  SETTINGS_CHANGED: 'settings-changed',
};

class Bus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(200);
  }

  publish(type, payload) {
    this.emit(type, payload);
  }

  /** 订阅，返回取消订阅函数 */
  subscribe(type, listener) {
    this.on(type, listener);
    return () => this.off(type, listener);
  }
}

export const bus = new Bus();
