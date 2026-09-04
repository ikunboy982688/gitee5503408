// Multi-provider proxy: /api/<provider>/<path...> -> <baseUrl>/<path...>
// The provider list is a hard whitelist: the browser can NEVER choose an
// arbitrary upstream host. This is what keeps the proxy from turning into an
// open relay / SSRF tool once it is deployed on a public *.pages.dev domain.

const PROVIDERS = {
  gitee: "https://ai.gitee.com/v1",
  siliconflow: "https://api.siliconflow.cn/v1",
  zhipu: "https://open.bigmodel.cn/api/paas/v4",
  dashscope: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  anges: "https://apihub.agnes-ai.com/v1",
  hunyuan: "https://api.tokenhub.tencentcloud.com/v1",
};

export async function onRequest(context) {
  const { request, params } = context;

  // CORS preflight
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsHeaders(),
    });
  }

  const provider = String(params.provider || "").toLowerCase();
  const base = PROVIDERS[provider];

  if (!base) {
    return new Response(
      JSON.stringify({
        error: `Unknown provider "${provider}"`,
        allowed: Object.keys(PROVIDERS),
      }),
      {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders() },
      }
    );
  }

  // Proxy to <base>/<path...>
  const path = (params.path || []).join("/");
  const targetUrl = new URL(`${base}/${path}`);
  const reqUrl = new URL(request.url);
  // forward query string
  targetUrl.search = reqUrl.search;

  // Clone headers; don't forward Host or Cloudflare's own client hints
  const headers = new Headers(request.headers);
  headers.delete("host");
  headers.delete("cf-connecting-ip");
  headers.delete("cf-ipcountry");
  headers.delete("cf-ray");
  headers.delete("cf-visitor");
  headers.delete("x-forwarded-for");
  headers.delete("x-forwarded-proto");
  headers.delete("x-real-ip");

  const init = {
    method: request.method,
    headers,
    redirect: "follow",
    cache: "no-store",
  };

  // Only attach body for non-GET/HEAD
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = request.body;
  }

  const upstream = await fetch(targetUrl.toString(), init);

  // Stream response; strip upstream cache headers, prevent edge caching, add CORS headers
  const respHeaders = new Headers(upstream.headers);
  respHeaders.delete("Cache-Control");
  respHeaders.delete("ETag");
  respHeaders.delete("Last-Modified");
  respHeaders.delete("Expires");
  respHeaders.delete("Age");
  respHeaders.delete("Vary");
  respHeaders.set("Cache-Control", "no-store, no-cache, must-revalidate");
  respHeaders.set("Pragma", "no-cache");
  for (const [k, v] of Object.entries(corsHeaders())) respHeaders.set(k, v);

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: respHeaders,
  });
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Max-Age": "86400",
  };
}
