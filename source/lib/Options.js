const LRU = require("lru-cache");
const util = require("./util");

class MiddlewareCache {
  constructor(lruCache) {
    this.lruCache = lruCache;
  }
  reset() {
    this.lruCache.reset();
  }
  clear(startsWith) {
    if (!startsWith) throw new Error("must pass what cache key startsWith");

    startsWith = startsWith.replace(/^https?/, "");
    let httpPath = `http${startsWith}`;
    let httpsPath = `https${startsWith}`;

    this.lruCache.forEach(function(v, k, cache) {
      if (k.startsWith(httpPath) || k.startsWith(httpsPath)) cache.del(k);
    });
  }
  clearKeys(keys) {
    if (!keys) throw new Error("must pass the cache keys");

    if (keys.length > 0) {
      keys.forEach((key) => {
        console.log(key);
        key = key.replace(/^https?/, "");
        let httpPath = `http${key}`;
        let httpsPath = `https${key}`;

        this.lruCache.forEach(function (v, k, cache) {
          if (k === httpPath || k === httpsPath) cache.del(k);
        });
      });
    }
  }
  set(url, res) {
    this.lruCache.set(url, res);
  }
  get(url) {
    return this.lruCache.get(url);
  }
}

let THROTTLED_URLS = {};

const configureMiddlewareCache = (middlewareCacheSingleton, lruCache) => {
  // this prevCache dump/load is just for tests
  const prevCache =
    middlewareCacheSingleton.instance &&
    middlewareCacheSingleton.instance.lruCache.dump();
  if (prevCache) lruCache.load(prevCache);

  middlewareCacheSingleton.instance = new MiddlewareCache(lruCache);
};

module.exports = class Options {
  constructor(middlewareCacheSingleton) {
    this.middlewareCacheSingleton = middlewareCacheSingleton;
    this.reset();
  }

  recordFail(url) {
    THROTTLED_URLS[url] = new Date();
    setTimeout(function() {
      THROTTLED_URLS[url] = undefined;
      delete THROTTLED_URLS[url];
    }, 5 * 60 * 1000);
  }

  isThrottled(url) {
    if (!this.options.throttleOnFail) return false;
    return !!THROTTLED_URLS[url];
  }

  reset() {
    THROTTLED_URLS = {};
    this.options = { retries: 1 };
  }

  static get validOptions() {
    return [
      "timeout",
      "prerenderServiceUrl",
      "prerenderToken",
      "beforeRender",
      "afterRender",
      "whitelistUserAgents",
      "originHeaderWhitelist",
      "botsOnly",
      "disableServerCache",
      "disableAjaxBypass",
      "disableAjaxPreload",
      "bubbleUp5xxErrors",
      "enableMiddlewareCache",
      "middlewareCacheMaxBytes",
      "middlewareCacheMaxAge",
      "whitelistQueryParams",
      "shouldPrerender",
      "removeScriptTags",
      "removeTrailingSlash",
      "protocol",
      "retries",
      "host",
      "waitExtraLong",
      "throttleOnFail"
    ];
  }

  set(prerenderMiddleware, name, val) {
    if (!Options.validOptions.includes(name))
      throw new Error(`${name} is unsupported option`);

    this.options[name] = val;

    if (name === "enableMiddlewareCache" && val === false) {
      this.middlewareCacheSingleton.instance = undefined;
    } else if (name.match(/middlewareCache/i)) {
      let lruCache = LRU({
        max: this.options.middlewareCacheMaxBytes || 500000000, // 500MB
        length: function(n, key) {
          return n.length;
        },
        dispose: function(key, n) {},
        maxAge: this.options.middlewareCacheMaxAge || 0 // 0 is forever
      });

      configureMiddlewareCache(this.middlewareCacheSingleton, lruCache);
    } else if (name === "whitelistQueryParams") {
      if (val != null && !util.isFunction(val)) {
        throw new Error("whitelistQueryParams must be a function");
      }
    }

    if (this.options["botsOnly"] && this.options["whitelistUserAgents"])
      throw new Error("Can't use both botsOnly and whitelistUserAgents");

    return prerenderMiddleware;
  }
};
