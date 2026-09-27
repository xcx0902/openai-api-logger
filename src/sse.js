/**
 * 极简 SSE（text/event-stream）解析器。
 *
 * 支持：event / data 字段（多行 data 以 \n 拼接）、注释行（: 开头）、
 * LF 与 CRLF 换行；跨 chunk 的半行会被缓存到下一次 push。
 * 解析结果原样交给回调，不做任何业务解释。
 */
export function createSseParser(onEvent) {
  let buffer = '';
  let eventName = null;
  let dataLines = [];

  function dispatch() {
    if (eventName === null && dataLines.length === 0) return;
    const payload = { event: eventName, data: dataLines.join('\n') };
    eventName = null;
    dataLines = [];
    onEvent(payload);
  }

  function handleLine(rawLine) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line === '') {
      dispatch();
      return;
    }
    if (line.startsWith(':')) return; // 注释 / 心跳
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') eventName = value;
    else if (field === 'data') dataLines.push(value);
    // id / retry 字段对本项目无意义，忽略
  }

  return {
    /** 喂入一段（可能是半截的）文本 */
    push(text) {
      if (!text) return;
      buffer += text;
      let idx = buffer.indexOf('\n');
      while (idx !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        handleLine(line);
        idx = buffer.indexOf('\n');
      }
    },
    /** 流结束时冲刷残留内容 */
    flush() {
      if (buffer) {
        handleLine(buffer);
        buffer = '';
      }
      dispatch();
    },
  };
}

/** 判断响应是否为 SSE 流 */
export function isEventStream(contentType) {
  return /text\/event-stream/i.test(String(contentType || ''));
}
