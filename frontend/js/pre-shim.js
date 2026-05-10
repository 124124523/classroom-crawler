// 모듈 형태인 api-shim.js 가 로드되기 전에 실행되는 동기 스크립트.
// 이 시점에 페이지의 inline script 가 fetch('/api/...') 를 호출하면
// 그 호출을 큐에 담아두고, 실제 shim 이 준비되면 처리한다.

(function () {
  const _origFetch = window.fetch.bind(window);
  window.__apiQueue = [];
  window.__originalFetch = _origFetch;

  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : input?.url;
    if (typeof url === 'string' && url.startsWith('/api/')) {
      return new Promise((resolve, reject) => {
        window.__apiQueue.push({ input, init, resolve, reject });
        if (window.__shimReady) window.__drainApiQueue();
      });
    }
    return _origFetch(input, init);
  };

  window.__drainApiQueue = function () {
    while (window.__apiQueue.length) {
      const { input, init, resolve, reject } = window.__apiQueue.shift();
      // 이때는 window.fetch 가 실제 shim 으로 대체된 상태
      window.fetch(input, init).then(resolve, reject);
    }
  };
})();
