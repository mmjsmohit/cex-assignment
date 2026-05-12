import { NextResponse, type NextRequest } from "next/server";

const DEFAULT_BACKEND_URL = "http://localhost:3000";

type RouteContext = {
  params: Promise<{
    path?: string[];
  }>;
};

async function proxyRequest(request: NextRequest, context: RouteContext) {
  const { path = [] } = await context.params;
  const backendBaseUrl = process.env.BACKEND_URL ?? DEFAULT_BACKEND_URL;
  const incomingUrl = new URL(request.url);
  const targetUrl = new URL(path.join("/"), ensureTrailingSlash(backendBaseUrl));
  targetUrl.search = incomingUrl.search;

  const headers = new Headers();
  const authorization = request.headers.get("authorization");
  const contentType = request.headers.get("content-type");

  if (authorization) {
    headers.set("authorization", authorization);
  }

  if (contentType) {
    headers.set("content-type", contentType);
  }

  try {
    const hasBody = request.method !== "GET" && request.method !== "HEAD";
    const backendResponse = await fetch(targetUrl, {
      method: request.method,
      headers,
      body: hasBody ? await request.text() : undefined,
      cache: "no-store",
    });

    const responseText = await backendResponse.text();
    const responseHeaders = new Headers();
    const responseContentType = backendResponse.headers.get("content-type");

    if (responseContentType) {
      responseHeaders.set("content-type", responseContentType);
    }

    return new NextResponse(responseText, {
      status: backendResponse.status,
      statusText: backendResponse.statusText,
      headers: responseHeaders,
    });
  } catch (error) {
    return NextResponse.json(
      {
        message: "Failed to reach backend",
        backendUrl: targetUrl.toString(),
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 502 },
    );
  }
}

function ensureTrailingSlash(value: string) {
  return value.endsWith("/") ? value : `${value}/`;
}

export const GET = proxyRequest;
export const POST = proxyRequest;
export const PUT = proxyRequest;
export const PATCH = proxyRequest;
export const DELETE = proxyRequest;
