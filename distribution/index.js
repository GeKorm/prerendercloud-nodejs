"use strict";

var _createClass = function () { function defineProperties(target, props) { for (var i = 0; i < props.length; i++) { var descriptor = props[i]; descriptor.enumerable = descriptor.enumerable || false; descriptor.configurable = true; if ("value" in descriptor) descriptor.writable = true; Object.defineProperty(target, descriptor.key, descriptor); } } return function (Constructor, protoProps, staticProps) { if (protoProps) defineProperties(Constructor.prototype, protoProps); if (staticProps) defineProperties(Constructor, staticProps); return Constructor; }; }();

function _defineProperty(obj, key, value) { if (key in obj) { Object.defineProperty(obj, key, { value: value, enumerable: true, configurable: true, writable: true }); } else { obj[key] = value; } return obj; }

function _classCallCheck(instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError("Cannot call a class as a function"); } }

var getNodeVersion = function getNodeVersion() {
  try {
    return parseFloat(process.version.replace(/v/, ""));
  } catch (err) {
    return null;
  }
};

var nodeVersion = getNodeVersion();

if (nodeVersion < 4.5) {
  console.log("prerendercloud requires node >= 4.5");
  process.exit(1);
}

require("./includes-polyfill");
if (!Array.isArray) {
  Array.isArray = function (arg) {
    return Object.prototype.toString.call(arg) === "[object Array]";
  };
}

var debug = require("debug")("prerendercloud");

var util = require("./lib/util");
var Url = require("./lib/Url");
var middlewareCacheSingleton = {};
var Options = require("./lib/Options");
var options = new Options(middlewareCacheSingleton);

var got = require("got-lite");
require("./lib/got-retries")(got, options, debug);

var vary = require("vary");

// preserve (and send to client) these headers from service.prerender.cloud which originally came from the origin server
var headerWhitelist = ["vary", "content-type", "cache-control", "strict-transport-security", "content-security-policy", "public-key-pins", "x-frame-options", "x-xss-protection", "x-content-type-options", "location"];

var botsOnlyList = ["googlebot", "yahoo", "bingbot", "baiduspider", "facebookexternalhit", "twitterbot", "rogerbot", "linkedinbot", "embedly", "quora link preview", "showyoubot", "outbrain", "pinterest/0.", "pinterestbot", "developers.google.com/+/web/snippet", "slackbot", "vkShare", "W3C_Validator", "redditbot", "Applebot", "WhatsApp", "flipboard", "tumblr", "bitlybot"].map(function (ua) {
  return ua.toLowerCase();
});

var userAgentIsBot = function userAgentIsBot(headers) {
  var requestedPath = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : "";

  var reqUserAgent = headers["user-agent"] && headers["user-agent"].toLowerCase() || "";

  if (headers["x-bufferbot"]) return true;

  if (requestedPath.match(/[?&]_escaped_fragment_/)) return true;

  return botsOnlyList.some(function (enabledUserAgent) {
    return reqUserAgent.includes(enabledUserAgent);
  });
};

var getServiceUrl = function getServiceUrl(hardcoded) {
  return hardcoded && hardcoded.replace(/\/+$/, "") || process.env.PRERENDER_SERVICE_URL || "https://service.prerender.cloud";
};
var getRenderUrl = function getRenderUrl(action, url) {
  return [getServiceUrl(), action, url].filter(function (p) {
    return p;
  }).join("/");
};

// from https://stackoverflow.com/a/41072596
// if there are multiple values with different case, it just takes the last
// (which is wrong, it should merge some of them according to the HTTP spec, but it's fine for now)
var objectKeysToLowerCase = function objectKeysToLowerCase(origObj) {
  return Object.keys(origObj).reduce(function (newObj, key) {
    var val = origObj[key];
    var newVal = typeof val === "object" ? objectKeysToLowerCase(val) : val;
    newObj[key.toLowerCase()] = newVal;
    return newObj;
  }, {});
};

var is5xxError = function is5xxError(statusCode) {
  return parseInt(statusCode / 100) === 5;
};
var is4xxError = function is4xxError(statusCode) {
  var n = parseInt(statusCode);
  var i = parseInt(statusCode / 100);

  return i === 4 && n !== 429;
};
var isGotClientTimeout = function isGotClientTimeout(err) {
  return err.name === "RequestError" && err.code === "ETIMEDOUT";
};

var zlib = require("zlib");
function compression(req, res, data) {
  if (req.headers["accept-encoding"] && req.headers["accept-encoding"].match(/gzip/i)) {
    zlib.gzip(data.body, function (err, gzipped) {
      if (err) {
        console.error(err);
        return res.status(500).send("compression error");
      }

      res.writeHead(data.statusCode, Object.assign({}, data.headers, { "content-encoding": "gzip" }));
      res.end(gzipped);
    });
  } else {
    res.writeHead(data.statusCode, data.headers);
    res.end(data.body);
  }
}

var handleSkip = function handleSkip(msg, next) {
  debug(msg);
  console.error("prerendercloud middleware SKIPPED:", msg);
  return next();
};

var concurrentRequestCache = {};

// response: { body, statusCode, headers }
function createResponse(requestedUrl, response) {
  var body = response.body;

  var lowerCasedHeaders = objectKeysToLowerCase(response.headers);

  var headers = {};
  headerWhitelist.forEach(function (h) {
    if (lowerCasedHeaders[h]) headers[h] = lowerCasedHeaders[h];
  });

  var data = { statusCode: response.statusCode, headers: headers, body: body };

  if (options.options.enableMiddlewareCache && ("" + response.statusCode).startsWith("2") && body && body.length) middlewareCacheSingleton.instance.set(requestedUrl, data);

  return data;
}

var Prerender = function () {
  function Prerender(req) {
    _classCallCheck(this, Prerender);

    this.req = req;
    this.url = Url.parse(req, options);
  }

  // promise cache wrapper around ._get to prevent concurrent requests to same URL


  _createClass(Prerender, [{
    key: "get",
    value: function get() {
      var _this = this;

      if (concurrentRequestCache[this.url.requestedUrl]) return concurrentRequestCache[this.url.requestedUrl];

      var promise = this._get();

      var deleteCache = function deleteCache() {
        concurrentRequestCache[_this.url.requestedUrl] = undefined;
        delete concurrentRequestCache[_this.url.requestedUrl];
      };

      return (concurrentRequestCache[this.url.requestedUrl] = promise).then(function (res) {
        deleteCache();
        return res;
      }).catch(function (err) {
        deleteCache();
        return Promise.reject(err);
      });
    }

    // fulfills promise when service.prerender.cloud response is: 2xx, 4xx
    // rejects promise when request lib errors or service.prerender.cloud response is: 5xx

  }, {
    key: "_get",
    value: function _get() {
      var _this2 = this;

      var apiRequestUrl = this._createApiRequestUrl();
      var headers = this._createHeaders();

      var requestPromise = void 0;

      if (options.isThrottled(this.url.requestedUrl)) {
        requestPromise = Promise.reject(new Error("throttled"));
      } else {
        debug("prerendering:", apiRequestUrl, headers);
        requestPromise = got.get(apiRequestUrl, {
          headers: headers,
          retries: options.options.retries,
          followRedirect: false,
          timeout: options.options.timeout || 20000
        });
      }

      return requestPromise.then(function (response) {
        return createResponse(_this2.url.requestedUrl, response);
      }).catch(function (err) {
        var shouldBubble = util.isFunction(options.options.bubbleUp5xxErrors) ? options.options.bubbleUp5xxErrors(err, _this2.req, err.response) : options.options.bubbleUp5xxErrors;

        options.recordFail(_this2.url.requestedUrl);

        if (shouldBubble) {
          if (err.response && is5xxError(err.response.statusCode)) return createResponse(_this2.url.requestedUrl, err.response);

          if (err.message && err.message.match(/throttle/)) {
            return createResponse(_this2.url.requestedUrl, {
              body: "Error: prerender.cloud client throttled this prerender request due to a recent timeout",
              statusCode: 503,
              headers: { "content-type": "text/html" }
            });
          }

          if (isGotClientTimeout(err)) return createResponse(_this2.url.requestedUrl, {
            body: "Error: prerender.cloud client timeout (as opposed to prerender.cloud server timeout)",
            statusCode: 500,
            headers: { "content-type": "text/html" }
          });

          return Promise.reject(err);
        } else if (err.response && is4xxError(err.response.statusCode)) {
          return createResponse(_this2.url.requestedUrl, err.response);
        }

        return Promise.reject(err);
      });
    }

    // data looks like { statusCode, headers, body }

  }, {
    key: "writeHttpResponse",
    value: function writeHttpResponse(req, res, next, data) {
      if (options.options.afterRender) process.nextTick(function () {
        return options.options.afterRender(null, req, data);
      });

      try {
        if (data.statusCode === 400) {
          res.statusCode = 400;
          return res.end("service.prerender.cloud can't prerender this page due to user error: " + data.body);
        } else if (data.statusCode === 429) {
          return handleSkip("rate limited due to free tier", next);
        } else {
          return compression(req, res, data);
        }
      } catch (error) {
        console.error("unrecoverable prerendercloud middleware error:", error && error.message);
        console.error("submit steps to reproduce here: https://github.com/sanfrancesco/prerendercloud-nodejs/issues");
        throw error;
      }
    }
  }, {
    key: "_shouldPrerender",
    value: function _shouldPrerender() {
      if (!(this.req && this.req.headers)) return false;

      if (this.req.method != "GET" && this.req.method != "HEAD") return false;

      if (this._alreadyPrerendered()) return false;

      if (!this._prerenderableExtension()) return false;

      if (this._isPrerenderCloudUserAgent()) return false;

      if (options.options.shouldPrerender) {
        return options.options.shouldPrerender(this.req);
      } else {
        return this._prerenderableUserAgent();
      }
    }
  }, {
    key: "_createHeaders",
    value: function _createHeaders() {
      var _this3 = this;

      var h = {
        "User-Agent": "prerender-cloud-nodejs-middleware",
        "accept-encoding": "gzip"
      };

      if (this.req.headers["user-agent"]) Object.assign(h, {
        "X-Original-User-Agent": this.req.headers["user-agent"]
      });

      var token = options.options.prerenderToken || process.env.PRERENDER_TOKEN;

      if (token) Object.assign(h, { "X-Prerender-Token": token });

      if (options.options.removeScriptTags) Object.assign(h, { "Prerender-Remove-Script-Tags": true });

      if (options.options.removeTrailingSlash) Object.assign(h, { "Prerender-Remove-Trailing-Slash": true });

      if (options.options.waitExtraLong) Object.assign(h, { "Prerender-Wait-Extra-Long": true });

      // disable prerender.cloud caching
      if (options.options.disableServerCache) Object.assign(h, { noCache: true });
      if (options.options.disableAjaxBypass) Object.assign(h, { "Prerender-Disable-Ajax-Bypass": true });
      if (options.options.disableAjaxPreload) Object.assign(h, { "Prerender-Disable-Ajax-Preload": true });

      if (this._hasOriginHeaderWhitelist()) {
        options.options.originHeaderWhitelist.forEach(function (_h) {
          if (_this3.req.headers[_h]) Object.assign(h, _defineProperty({}, _h, _this3.req.headers[_h]));
        });

        Object.assign(h, {
          "Origin-Header-Whitelist": options.options.originHeaderWhitelist.join(" ")
        });
      }

      return h;
    }
  }, {
    key: "_hasOriginHeaderWhitelist",
    value: function _hasOriginHeaderWhitelist() {
      return options.options.originHeaderWhitelist && Array.isArray(options.options.originHeaderWhitelist);
    }
  }, {
    key: "_createApiRequestUrl",
    value: function _createApiRequestUrl() {
      return getRenderUrl(null, this.url.requestedUrl);
    }
  }, {
    key: "_alreadyPrerendered",
    value: function _alreadyPrerendered() {
      return !!this.req.headers["x-prerendered"];
    }
  }, {
    key: "_prerenderableExtension",
    value: function _prerenderableExtension() {
      return this.url.hasHtmlPath;
    }
  }, {
    key: "_isPrerenderCloudUserAgent",
    value: function _isPrerenderCloudUserAgent() {
      var reqUserAgent = this.req.headers["user-agent"];

      if (!reqUserAgent) return false;

      reqUserAgent = reqUserAgent.toLowerCase();

      return reqUserAgent.match(/prerendercloud/i);
    }
  }, {
    key: "_prerenderableUserAgent",
    value: function _prerenderableUserAgent() {
      var reqUserAgent = this.req.headers["user-agent"];

      if (!reqUserAgent) return false;

      if (options.options.whitelistUserAgents) return options.options.whitelistUserAgents.some(function (enabledUserAgent) {
        return reqUserAgent.includes(enabledUserAgent);
      });

      if (!options.options.botsOnly) return true;

      // bots only
      return userAgentIsBot(this.req.headers, this.url.original);
    }
  }], [{
    key: "middleware",
    value: function middleware(req, res, next) {
      var prerender = new Prerender(req);

      var objForReqRes = {
        url: { requestedPath: prerender.url.requestedPath }
      };
      // this is for beforeRender(req, done) func so there's visibility into what URL is being used
      req.prerender = objForReqRes;
      // this is for lambda@edge downstream: https://github.com/sanfrancesco/prerendercloud-lambda-edge
      res.prerender = objForReqRes;

      if (options.options.botsOnly) {
        vary(res, "User-Agent");
      }

      if (!prerender._shouldPrerender()) {
        debug("NOT prerendering", req.originalUrl, req && req.headers && { "user-agent": req.headers["user-agent"] });
        return next();
      }

      if (options.options.enableMiddlewareCache) {
        var cached = middlewareCacheSingleton.instance.get(prerender.url.requestedUrl);
        if (cached) {
          debug("returning cache", req.originalUrl, req && req.headers && { "user-agent": req.headers["user-agent"] });
          return prerender.writeHttpResponse(req, res, next, cached);
        }
      }

      var remotePrerender = function remotePrerender() {
        return prerender.get().then(function (data) {
          return prerender.writeHttpResponse(req, res, next, data);
        }).catch(function (error) {
          return handleSkip("server error: " + (error && error.message), next);
        });
      };

      if (options.options.beforeRender) {
        var donePassedToUserBeforeRender = function donePassedToUserBeforeRender(err, stringOrObject) {
          if (!stringOrObject) {
            return remotePrerender();
          } else if (typeof stringOrObject === "string") {
            return prerender.writeHttpResponse(req, res, next, {
              statusCode: 200,
              headers: {
                "content-type": "text/html; charset=utf-8"
              },
              body: stringOrObject
            });
          } else if (typeof stringOrObject === "object") {
            return prerender.writeHttpResponse(req, res, next, {
              statusCode: stringOrObject.status,
              headers: Object.assign({
                "content-type": "text/html; charset=utf-8"
              }, stringOrObject.headers),
              body: stringOrObject.body
            });
          }
        };
        return options.options.beforeRender(req, donePassedToUserBeforeRender);
      } else {
        return remotePrerender();
      }
    }
  }]);

  return Prerender;
}();

Prerender.middleware.set = options.set.bind(options, Prerender.middleware);
// Prerender.middleware.cache =
Object.defineProperty(Prerender.middleware, "cache", {
  get: function get() {
    return middlewareCacheSingleton.instance;
  }
});

var screenshotAndPdf = function screenshotAndPdf(action, url, params) {
  var headers = {};

  var token = options.options.prerenderToken || process.env.PRERENDER_TOKEN;

  if (token) Object.assign(headers, { "X-Prerender-Token": token });

  return got(getRenderUrl(action, url), {
    encoding: null,
    headers: headers,
    retries: options.options.retries
  }).then(function (res) {
    return res.body;
  });
};

Prerender.middleware.screenshot = screenshotAndPdf.bind(undefined, "screenshot");
Prerender.middleware.pdf = screenshotAndPdf.bind(undefined, "pdf");

Prerender.middleware.botsOnlyList = botsOnlyList;
Prerender.middleware.userAgentIsBot = userAgentIsBot;

Prerender.middleware.util = util;

// for testing only
Prerender.middleware.resetOptions = options.reset.bind(options);
Prerender.middleware.Options = Options;

module.exports = Prerender.middleware;