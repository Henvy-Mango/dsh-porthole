// 滑动窗口请求速率限制器（沿用上游实现）
// 用途：RPC 通道限流、登录失败封禁。

export class RateLimiter {
  /**
   * @param {object} options
   * @param {number} [options.maxRequests] 窗口期内允许的最大请求数（默认 30）
   * @param {number} [options.windowMs] 时间窗口毫秒数（默认 60000）
   */
  constructor({ maxRequests = 30, windowMs = 60000 } = {}) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
    /** @type {Map<string, number[]>} key -> 时间戳队列 */
    this.hits = new Map();
  }

  /**
   * 记录一次请求并判断是否超限。
   * @param {string} [key] 限流维度（默认全局）
   * @returns {boolean} true = 允许，false = 已超限
   */
  allow(key = '__global__') {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    let queue = this.hits.get(key);
    if (!queue) {
      queue = [];
      this.hits.set(key, queue);
    }
    // 丢弃窗口外的时间戳（队列按时间递增，从头裁）
    let drop = 0;
    while (drop < queue.length && queue[drop] <= cutoff) drop += 1;
    if (drop > 0) queue.splice(0, drop);

    if (queue.length >= this.maxRequests) return false;
    queue.push(now);
    return true;
  }

  /** 清空全部计数（测试/重置用） */
  reset() {
    this.hits.clear();
  }
}
