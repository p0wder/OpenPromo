import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** A fixture's XML. */
export const fixture = (name: string) => readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8");

export interface FakeCall {
  url: string;
  soapAction: string;
  operation: string;
  xml: string;
}

type Answer = string | { status: number; body: string } | Error;

/**
 * A stand-in `fetch` for SOAP: answers by the request's operation element
 * ("GetOrderStatusRequest", "getPricing"), records every call. Nothing
 * reaches a real supplier.
 */
export function fakeSoap(routes: Record<string, Answer | ((call: FakeCall) => Answer)>) {
  const calls: FakeCall[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const xml = String(init?.body ?? "");
    const operation = /<soapenv:Body>\s*<[\w-]+:([\w-]+)>/.exec(xml)?.[1] ?? "";
    const headers = new Headers(init?.headers);
    const call = { url: String(url), soapAction: headers.get("SOAPAction") ?? "", operation, xml };
    calls.push(call);
    const route = routes[operation];
    if (route === undefined) return new Response(`no route for ${operation}`, { status: 500 });
    const answer = typeof route === "function" ? route(call) : route;
    if (answer instanceof Error) throw answer;
    if (typeof answer === "string") return new Response(answer, { status: 200, headers: { "Content-Type": "text/xml" } });
    return new Response(answer.body, { status: answer.status });
  }) as typeof fetch;
  return { fetch: impl, calls };
}

/** The text of every element with this local name in a request. */
export const elementsOf = (xml: string, name: string) => [...xml.matchAll(new RegExp(`<(?:[\\w-]+:)?${name}>([^<]*)</`, "g"))].map((m) => m[1]);
