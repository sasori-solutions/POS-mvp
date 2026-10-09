// Only the root path invokes this worker; all other paths use native Pages serving.
export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    if (url.hostname === 'pos.larioscow.dev' && url.pathname === '/' && ['GET', 'HEAD'].includes(request.method)) {
      url.pathname = '/landing/'
      return env.ASSETS.fetch(new Request(url, request))
    }
    return env.ASSETS.fetch(request)
  },
}
