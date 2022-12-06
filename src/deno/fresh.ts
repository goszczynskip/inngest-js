import { z } from "zod";
import {
  InngestCommHandler,
  serve as defaultServe,
  ServeHandler,
} from "../express";
import { envKeys, queryKeys } from "../helpers/consts";
import { devServerUrl } from "../helpers/devserver";
import { devServerHost } from "../helpers/env";
import { landing } from "../landing";
import type { IntrospectRequest } from "../types";

class DenoFreshCommHandler extends InngestCommHandler {
  protected override frameworkName = "deno/fresh";

  public override createHandler() {
    return async (
      req: Request,
      env: { [index: string]: string }
    ): Promise<Response> => {
      const headers = { "x-inngest-sdk": this.sdkHeader.join("") };

      let reqUrl: URL;
      let isIntrospection: boolean;

      try {
        reqUrl = this.reqUrl(
          req.url,
          `https://${req.headers.get("host") || ""}`
        );
        isIntrospection = reqUrl.searchParams.has(queryKeys.Introspect);
        reqUrl.searchParams.delete(queryKeys.Introspect);
      } catch (err) {
        return new Response(JSON.stringify(err), {
          status: 500,
          headers,
        });
      }

      if (!this.signingKey && env[envKeys.SigningKey]) {
        this.signingKey = env[envKeys.SigningKey];
      }

      this._isProd =
        env.VERCEL_ENV === "production" ||
        env.CONTEXT === "production" ||
        env.ENVIRONMENT === "production";

      switch (req.method) {
        case "GET": {
          const showLandingPage = this.shouldShowLandingPage(
            env[envKeys.LandingPage]
          );

          if (this._isProd || !showLandingPage) break;

          if (isIntrospection) {
            const introspection: IntrospectRequest = {
              ...this.registerBody(reqUrl),
              devServerURL: devServerUrl(devServerHost()).href,
              hasSigningKey: Boolean(this.signingKey),
            };

            return new Response(JSON.stringify(introspection), {
              status: 200,
              headers,
            });
          }

          // Grab landing page and serve
          return new Response(landing, {
            status: 200,
            headers: {
              ...headers,
              "content-type": "text/html; charset=utf-8",
            },
          });
        }

        case "PUT": {
          // Push config to Inngest.
          const { status, message } = await this.register(
            reqUrl,
            env[envKeys.DevServerUrl]
          );

          return new Response(JSON.stringify({ message }), {
            status,
            headers,
          });
        }

        case "POST": {
          // Inngest is trying to run a step; confirm signed and run.
          const { fnId, stepId } = z
            .object({
              fnId: z.string().min(1),
              stepId: z.string().min(1),
            })
            .parse({
              fnId: reqUrl.searchParams.get(queryKeys.FnId),
              stepId: reqUrl.searchParams.get(queryKeys.StepId),
            });

          const stepRes = await this.runStep(fnId, stepId, await req.json());

          if (stepRes.status === 500) {
            return new Response(JSON.stringify(stepRes.error), {
              status: stepRes.status,
              headers,
            });
          }

          return new Response(JSON.stringify(stepRes.body), {
            status: stepRes.status,
            headers,
          });
        }
      }

      return new Response(null, { status: 405, headers });
    };
  }
}

/**
 * In Remix, serve and register any declared functions with Inngest, making them
 * available to be triggered by events.
 *
 * Remix requires that you export both a "loader" for serving `GET` requests,
 * and an "action" for serving other requests, therefore exporting both is
 * required.
 *
 * See {@link https://remix.run/docs/en/v1/guides/resource-routes}
 *
 * @example
 * ```ts
 * import { serve } from "inngest/remix";
 * import fns from "~/inngest";
 *
 * const handler = serve("My Remix App", fns);
 *
 * export { handler as loader, handler as action };
 * ```
 *
 * @public
 */
export const serve: ServeHandler = (nameOrInngest, fns, opts): any => {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const handler = defaultServe(
    new DenoFreshCommHandler(nameOrInngest, fns, opts)
  );

  // eslint-disable-next-line @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call
  return (req: Request) => handler(req, Deno.env.toObject());
};

declare const Deno: { env: { toObject: () => { [index: string]: string } } };
