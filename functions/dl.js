// Download proxy for generated image/video files.
//
// SECURITY: the original version accepted ANY http(s) URL, which made this a
// general-purpose open proxy (abusable as an SSRF relay by anyone who finds the
// *.pages.dev domain). Now only hostnames belonging to the configured AI
// providers are allowed. Match rule is exact host or a subdomain of it, so
// "evil-siliconflow.cn" will NOT pass.

const ALLOWED_HOST_SUFFIXES = [
  "ai.gitee.com",
  "gitee.com",
  "siliconflow.cn",
  "bigmodel.cn",
  "aliyuncs.com",
  "agnes-ai.com",
  "tencentcloud.com",
  "myqcloud.com",
];

function hostAllowed(hostname) {
  const h = String(hostname || "").toLowerCase();
  if (!h) return false;
  return ALLOWED_HOST_SUFFIXES.some((s) => h === s || h.endsWith("." + s));
}

export async function onRequest(context) {
  const { request } = context;

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  const url = new URL(request.url);
  const target = url.searchParams.get("url") || "";

  if (!target || !(target.startsWith("https://") || target.startsWith("http://"))) {
    return new Response(JSON.stringify({ error: "Invalid or missing url param" }), {
      status: 400,
      headers: { "Content-Type": "application/json", ...corsHeaders() },
    });
  }

  let parsed;
  try {
    parsed = new URL(target);
  } catch {
    return new Response(JSON.stringify({ error: "Malformed url param" }), {
      status: 400,
      headers: { "Content-Type": "application/json", ...corsHeaders() },
    });
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return new Response(JSON.stringify({ error: "Unsupported protocol" }), {
      status: 400,
      headers: { "Content-Type": "application/json", ...corsHeaders() },
    });
  }

  if (!hostAllowed(parsed.hostname)) {
    return new Response(
      JSON.stringify({
        error: "Host not allowed",
        host: parsed.hostname,
        allowed: ALLOWED_HOST_SUFFIXES,
      }),
      { status: 403, headers: { "Content-Type": "application/json", ...corsHeaders() } }
    );
  }

  // Forward a minimal set of headers (Range helps for video)
  const h = new Headers();
  const range = request.headers.get("Range");
  if (range) h.set("Range", range);

  const upstream = await fetch(target, { method: "GET", headers: h, redirect: "follow", cache: "no-store" });

  // Strip upstream cache headers, prevent edge caching
  const respHeaders = new Headers(upstream.headers);
  respHeaders.delete("Cache-Control");
  respHeaders.delete("ETag");
  respHeaders.delete("Last-Modified");
  respHeaders.delete("Expires");
  respHeaders.delete("Age");
  respHeaders.delete("Vary");
  respHeaders.set("Cache-Control", "no-store, no-cache, must-revalidate");
  respHeaders.set("Pragma", "no-cache");
  // Some hosts send restrictive headers; loosen for download/view
  respHeaders.delete("Content-Security-Policy");
  respHeaders.delete("X-Frame-Options");
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
    "Access-Control-Allow-Methods": "GET,OPTIONS",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Max-Age": "86400",
  };
}
