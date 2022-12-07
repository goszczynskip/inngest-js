import { sha256 } from "hash.js";
import { z } from "zod";
import { envKeys, queryKeys } from "../helpers/consts";
import { devServerAvailable, devServerUrl } from "../helpers/devserver";
import { strBoolean } from "../helpers/scalar";
import type { MaybePromise } from "../helpers/types";
import { landing } from "../landing";
import type {
  FunctionConfig,
  IntrospectRequest,
  RegisterOptions,
  RegisterRequest,
  StepRunResponse,
} from "../types";
import { version } from "../version";
import type { Inngest } from "./Inngest";
import type { InngestFunction } from "./InngestFunction";

/**
 * A handler for serving Inngest functions. This type should be used
 * whenever a handler for a new framework is being added to enforce that the
 * registration process is always the same for the user.
 *
 * @public
 */
export type ServeHandler = (
  /**
   * The name of this app, used to scope and group Inngest functions, or
   * the `Inngest` instance used to declare all functions.
   */
  nameOrInngest: string | Inngest<any>,

  /**
   * An array of the functions to serve and register with Inngest.
   */
  functions: InngestFunction<any>[],

  /**
   * A set of options to further configure the registration of Inngest
   * functions.
   */
  opts?: RegisterOptions
) => any;

/**
 * Capturing the global type of fetch so that we can reliably access it below.
 */
type FetchT = typeof fetch;

/**
 * A schema for the response from Inngest when registering.
 */
const registerResSchema = z.object({
  status: z.number().default(200),
  skipped: z.boolean().optional().default(false),
  error: z.string().default("Successfully registered"),
});

/**
 * TODO Instead of `createHandler`, expose `createRequest` and `handleResponse`
 *
 * Overriding `createHandler` requires that we always remember crucial steps,
 * e.g. validating signatures, handling POST, etc.
 *
 * We should instead require that new comm handlers override only two functions:
 *
 * `createRequest()`
 * This is the function that is exposed. It must return a valid `HandlerRequest`
 *
 * `handleResponse()`
 * The input is a `StepResponse`, and output can be anything needed for the
 * platform
 *
 * This needs to also account for the ability to validate signatures etc.
 *
 * @public
 */
export class InngestCommHandler<H extends Handler, TransformedRes> {
  public name: string;
  public readonly handler: H;
  public readonly transformRes: (
    res: ActionResponse,
    ...args: Parameters<H>
  ) => TransformedRes;

  /**
   * The URL of the Inngest function registration endpoint.
   */
  private readonly inngestRegisterUrl: URL;

  protected readonly frameworkName: string;
  protected signingKey: string | undefined;

  /**
   * A property that can be set to indicate whether or not we believe we are in
   * production mode.
   *
   * Should be set every time a request is received.
   */
  protected _isProd = false;
  private readonly headers: Record<string, string>;
  private readonly fetch: FetchT;

  /**
   * Whether we should show the SDK Landing Page.
   *
   * This purposefully does not take in to account any environment variables, as
   * accessing them safely is platform-specific.
   */
  protected readonly showLandingPage: boolean | undefined;

  protected readonly serveHost: string | undefined;
  protected readonly servePath: string | undefined;

  /**
   * A private collection of functions that are being served. This map is used
   * to find and register functions when interacting with Inngest Cloud.
   */
  private readonly fns: Record<string, InngestFunction<any>> = {};

  constructor(
    frameworkName: string,
    appNameOrInngest: string | Inngest<any>,
    functions: InngestFunction<any>[],
    {
      inngestRegisterUrl,
      fetch,
      landingPage,
      signingKey,
      serveHost,
      servePath,
    }: RegisterOptions = {},
    handler: H,
    transformRes: (
      actionRes: ActionResponse,
      ...args: Parameters<H>
    ) => TransformedRes
  ) {
    this.frameworkName = frameworkName;
    this.name =
      typeof appNameOrInngest === "string"
        ? appNameOrInngest
        : appNameOrInngest.name;

    this.handler = handler;
    this.transformRes = transformRes;

    this.fns = functions.reduce<Record<string, InngestFunction<any>>>(
      (acc, fn) => {
        const id = fn.id(this.name);

        if (acc[id]) {
          throw new Error(
            `Duplicate function ID "${id}"; please change a function's name or provide an explicit ID to avoid conflicts.`
          );
        }

        return {
          ...acc,
          [id]: fn,
        };
      },
      {}
    );

    this.inngestRegisterUrl = new URL(
      inngestRegisterUrl || "https://api.inngest.com/fn/register"
    );

    this.signingKey = signingKey;
    this.showLandingPage = landingPage;
    this.serveHost = serveHost;
    this.servePath = servePath;

    this.headers = {
      "Content-Type": "application/json",
      "User-Agent": `inngest-js:v${version} (${this.frameworkName})`,
    };

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    this.fetch = fetch || (require("cross-fetch") as FetchT);
  }

  // hashedSigningKey creates a sha256 checksum of the signing key with the
  // same signing key prefix.
  private get hashedSigningKey(): string {
    if (!this.signingKey) {
      return "";
    }

    const prefix =
      this.signingKey.match(/^signkey-(test|prod)-/)?.shift() || "";
    const key = this.signingKey.replace(/^signkey-(test|prod)-/, "");

    // Decode the key from its hex representation into a bytestream
    return `${prefix}${sha256().update(key, "hex").digest("hex")}`;
  }

  public createHandler(): (...args: Parameters<H>) => Promise<TransformedRes> {
    return async (...args: Parameters<H>) => {
      // eslint-disable-next-line @typescript-eslint/await-thenable
      const actions = await this.handler(...args);
      const actionRes = await this.handleAction(
        actions as ReturnType<Awaited<H>>
      );
      return this.transformRes(actionRes, ...args);
    };
  }

  private async handleAction(actions: ReturnType<H>): Promise<ActionResponse> {
    const headers = { "x-inngest-sdk": this.sdkHeader.join("") };

    try {
      const runRes = await actions.run();
      if (runRes) {
        this.upsertSigningKeyFromEnv(runRes.env);

        const stepRes = await this.runStep(runRes.fnId, "step", runRes.data);

        if (stepRes.status === 500) {
          return {
            status: 500,
            body: stepRes.error || "",
            headers: {
              ...headers,
              "Content-Type": "application/json",
            },
          };
        }

        return {
          status: stepRes.status,
          body: JSON.stringify(stepRes.body),
          headers: {
            ...headers,
            "Content-Type": "application/json",
          },
        };
      }

      const viewRes = await actions.view();
      if (viewRes) {
        this.upsertSigningKeyFromEnv(viewRes.env);

        const showLandingPage = this.shouldShowLandingPage(
          viewRes.env[envKeys.LandingPage]
        );

        if (this._isProd || !showLandingPage) {
          return {
            status: 405,
            body: "",
            headers,
          };
        }

        if (viewRes.isIntrospection) {
          const introspection: IntrospectRequest = {
            ...this.registerBody(this.reqUrl(viewRes.url)),
            devServerURL: devServerUrl(viewRes.env[envKeys.DevServerUrl]).href,
            hasSigningKey: Boolean(this.signingKey),
          };

          return {
            status: 200,
            body: JSON.stringify(introspection),
            headers: {
              ...headers,
              "Content-Type": "application/json",
            },
          };
        }

        return {
          status: 200,
          body: landing,
          headers: {
            ...headers,
            "Content-Type": "text/html; charset=utf-8",
          },
        };
      }

      const registerRes = await actions.register();
      if (registerRes) {
        this.upsertSigningKeyFromEnv(registerRes.env);

        const { status, message } = await this.register(
          this.reqUrl(registerRes.url),
          registerRes.env[envKeys.DevServerUrl]
        );

        return {
          status,
          body: JSON.stringify({ message }),
          headers: {
            ...headers,
            "Content-Type": "application/json",
          },
        };
      }
    } catch (err) {
      return {
        status: 500,
        body: JSON.stringify(err),
        headers: {
          ...headers,
          "Content-Type": "application/json",
        },
      };
    }

    return {
      status: 405,
      body: "",
      headers,
    };
  }

  protected async runStep(
    functionId: string,
    stepId: string,
    data: any
  ): Promise<StepRunResponse> {
    try {
      const fn = this.fns[functionId];
      if (!fn) {
        throw new Error(`Could not find function with ID "${functionId}"`);
      }

      const { event, steps } = z
        .object({
          event: z.object({}).passthrough(),
          steps: z.object({}).passthrough().optional().nullable(),
        })
        .parse(data);

      const ret = await fn["runFn"]({ event }, steps || {});
      const isOp = ret[0];

      if (isOp) {
        return {
          status: 206,
          body: ret[1],
        };
      }

      return {
        status: 200,
        body: ret[1],
      };
    } catch (err: unknown) {
      if (err instanceof Error) {
        return {
          status: 500,
          error: err.stack || err.message,
        };
      }

      return {
        status: 500,
        error: `Unknown error: ${JSON.stringify(err)}`,
      };
    }
  }

  protected configs(url: URL): FunctionConfig[] {
    return Object.values(this.fns).map((fn) => fn["getConfig"](url, this.name));
  }

  /**
   * Returns an SDK header split in to three parts so that they can be used for
   * different purposes.
   *
   * To use the entire string, run `this.sdkHeader.join("")`.
   */
  protected get sdkHeader(): [
    prefix: string,
    version: RegisterRequest["sdk"],
    suffix: string
  ] {
    return ["inngest-", `js:v${version}`, ` (${this.frameworkName})`];
  }

  /**
   * Return an Inngest serve endpoint URL given a potential `path` and `host`.
   *
   * Will automatically use the `serveHost` and `servePath` if they have been
   * set when registering.
   */
  protected reqUrl(url: URL): URL {
    let ret = new URL(url);

    if (this.servePath) ret.pathname = this.servePath;
    if (this.serveHost)
      ret = new URL(ret.pathname + ret.search, this.serveHost);

    /**
     * Remove any introspection query strings.
     */
    ret.searchParams.delete(queryKeys.Introspect);

    return ret;
  }

  protected registerBody(url: URL): RegisterRequest {
    const body: RegisterRequest = {
      url: url.href,
      deployType: "ping",
      framework: this.frameworkName,
      appName: this.name,
      functions: this.configs(url),
      sdk: this.sdkHeader[1],
      v: "0.1",
    };

    // Calculate the checksum of the body... without the checksum itself being included.
    body.hash = sha256().update(JSON.stringify(body)).digest("hex");
    return body;
  }

  protected async register(
    url: URL,
    devServerHost: string | undefined
  ): Promise<{ status: number; message: string }> {
    const body = this.registerBody(url);

    let res: globalThis.Response;

    // Whenever we register, we check to see if the dev server is up.  This
    // is a noop and returns false in production.
    let registerURL = this.inngestRegisterUrl;

    if (!this.isProd) {
      const hasDevServer = await devServerAvailable(devServerHost, this.fetch);
      if (hasDevServer) {
        registerURL = devServerUrl(devServerHost, "/fn/register");
      }
    }

    try {
      res = await this.fetch(registerURL.href, {
        method: "POST",
        body: JSON.stringify(body),
        headers: {
          ...this.headers,
          Authorization: `Bearer ${this.hashedSigningKey}`,
        },
        redirect: "follow",
      });
    } catch (err: unknown) {
      console.error(err);

      return {
        status: 500,
        message: `Failed to register${
          err instanceof Error ? `; ${err.message}` : ""
        }`,
      };
    }

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    let data: z.input<typeof registerResSchema> = {};

    try {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      data = await res.json();
    } catch (err) {
      console.warn("Couldn't unpack register response:", err);
    }
    const { status, error, skipped } = registerResSchema.parse(data);

    // The dev server polls this endpoint to register functions every few
    // seconds, but we only want to log that we've registered functions if
    // the function definitions change.  Therefore, we compare the body sent
    // during registration with the body of the current functions and refuse
    // to register if the functions are the same.
    if (!skipped) {
      console.log(
        "registered inngest functions:",
        res.status,
        res.statusText,
        data
      );
    }

    return { status, message: error };
  }

  private get isProd() {
    return this._isProd;
  }

  private upsertSigningKeyFromEnv(env: Record<string, string | undefined>) {
    if (!this.signingKey && env[envKeys.SigningKey]) {
      this.signingKey = env[envKeys.SigningKey];
    }
  }

  protected shouldShowLandingPage(strEnvVar: string | undefined): boolean {
    return this.showLandingPage ?? strBoolean(strEnvVar) ?? true;
  }

  protected validateSignature(): boolean {
    return true;
  }

  protected signResponse(): string {
    return "";
  }
}

type Handler = (...args: any[]) => {
  [K in Extract<
    HandlerAction,
    { action: "run" | "register" | "view" }
  >["action"]]: () => MaybePromise<
    Omit<Extract<HandlerAction, { action: K }>, "action"> | undefined
  >;
};

interface ActionResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

type HandlerAction =
  | {
      action: "error";
      data: Record<string, string>;
      env: Record<string, string | undefined>;
      isProduction: boolean;
      url: URL;
    }
  | {
      action: "view";
      env: Record<string, string | undefined>;
      url: URL;
      isIntrospection: boolean;
      isProduction: boolean;
    }
  | {
      action: "register";
      env: Record<string, string | undefined>;
      url: URL;
      isProduction: boolean;
    }
  | {
      action: "run";
      fnId: string;
      data: Record<string, any>;
      env: Record<string, string | undefined>;
      isProduction: boolean;
      url: URL;
    }
  | {
      action: "bad-method";
      env: Record<string, string | undefined>;
      isProduction: boolean;
      url: URL;
    };