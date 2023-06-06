import chalk from "chalk";
import {
  deserializeError as cjsDeserializeError,
  serializeError as cjsSerializeError,
} from "serialize-error-cjs";
import { type Inngest } from "../components/Inngest";
import { type ClientOptions, type OutgoingOp } from "../types";

const SERIALIZED_KEY = "__serialized";
const SERIALIZED_VALUE = true;

export interface SerializedError {
  readonly [SERIALIZED_KEY]: typeof SERIALIZED_VALUE;
  readonly name: string;
  readonly message: string;
  readonly stack: string;
}

/**
 * Serialise an error to a plain object.
 *
 * Errors do not serialise nicely to JSON, so we use this function to convert
 * them to a plain object. Doing this is also non-trivial for some errors, so
 * we use the `serialize-error` package to do it for us.
 *
 * See {@link https://www.npmjs.com/package/serialize-error}
 *
 * This function is a small wrapper around that package to also add a `type`
 * property to the serialised error, so that we can distinguish between
 * serialised errors and other objects.
 *
 * Will not reserialise existing serialised errors.
 */
export const serializeError = (subject: unknown): SerializedError => {
  if (isSerializedError(subject)) {
    return subject as SerializedError;
  }

  return {
    ...cjsSerializeError(subject as Error),
    [SERIALIZED_KEY]: SERIALIZED_VALUE,
  } as const;
};

/**
 * Check if an object is a serialised error created by {@link serializeError}.
 */
export const isSerializedError = (value: unknown): boolean => {
  try {
    return (
      Object.prototype.hasOwnProperty.call(value, SERIALIZED_KEY) &&
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      (value as { [SERIALIZED_KEY]: unknown })[SERIALIZED_KEY] ===
        SERIALIZED_VALUE
    );
  } catch {
    return false;
  }
};

/**
 * Deserialise an error created by {@link serializeError}.
 *
 * Ensures we only deserialise errors that meet a minimum level of
 * applicability, inclusive of error handling to ensure that badly serialized
 * errors are still handled.
 */
export const deserializeError = (subject: Partial<SerializedError>): Error => {
  const requiredFields: (keyof SerializedError)[] = ["name", "message"];

  try {
    const hasRequiredFields = requiredFields.every((field) => {
      return Object.prototype.hasOwnProperty.call(subject, field);
    });

    if (!hasRequiredFields) {
      throw new Error();
    }

    return cjsDeserializeError(subject as SerializedError);
  } catch {
    const err = new Error("Unknown error; could not reserialize");

    /**
     * Remove the stack so that it's not misleadingly shown as the Inngest
     * internals.
     */
    err.stack = undefined;

    return err;
  }
};

export enum ErrCode {
  ASYNC_DETECTED_DURING_MEMOIZATION = "ASYNC_DETECTED_DURING_MEMOIZATION",
  ASYNC_DETECTED_AFTER_MEMOIZATION = "ASYNC_DETECTED_AFTER_MEMOIZATION",
  STEP_USED_AFTER_ASYNC = "STEP_USED_AFTER_ASYNC",
  NESTING_STEPS = "NESTING_STEPS",
}

export interface PrettyError {
  /**
   * The type of message, used to decide on icon and color use.
   */
  type?: "error" | "warn";

  /**
   * A short, succinct description of what happened. Will be used as the error's
   * header, so should be short and to the point with no trailing punctuation.
   */
  whatHappened: string;

  /**
   * If applicable, provide a full sentence to reassure the user about certain
   * details, for example if an error occurred whilst uploading a file, but we
   * can assure the user that uploading succeeded and something internal failed.
   */
  reassurance?: string;

  /**
   * Tell the user why the error happened if we can. This should be a full
   * sentence or paragraph that explains the error in more detail, for example
   * to explain that a file failed to upload because it was too large and that
   * the maximum size is 10MB.
   */
  why?: string;

  /**
   * If applicable, tell the user what the consequences of the error are, for
   * example to tell them that their file was not uploaded and that they will
   * need to try again.
   */
  consequences?: string;

  /**
   * If we can, tell the user what they can do to fix the error now. This should
   * be a full sentence or paragraph that explains what the user can do to fix
   * the error, for example to tell them to try uploading a smaller file or
   * upgrade to a paid plan.
   */
  toFixNow?: string | string[];

  /**
   * If applicable, tell the user what to do if the error persists, they want
   * more information, or the fix we've given them doesn't work.
   *
   * This should be a full sentence or paragraph, and will likely refer users
   * to contact us for support, join our Discord, or read documentation.
   */
  otherwise?: string;

  /**
   * Add a stack trace to the message so that the user knows what line of code
   * the error is in relation to.
   */
  stack?: true;

  /**
   * If applicable, provide a code that the user can use to reference the error
   * when contacting support.
   */
  code?: ErrCode;
}

/**
 * Given a {@link PrettyError}, return a nicely-formatted string ready to log
 * or throw.
 *
 * Useful for ensuring that errors are logged in a consistent, helpful format
 * across the SDK by prompting for key pieces of information.
 */
export const prettyError = ({
  type = "error",
  whatHappened,
  otherwise,
  reassurance,
  toFixNow,
  why,
  consequences,
  stack,
  code,
}: PrettyError): string => {
  const { icon, colorFn } = (
    {
      error: { icon: "❌", colorFn: chalk.red },
      warn: { icon: "⚠️", colorFn: chalk.yellow },
    } satisfies Record<
      NonNullable<PrettyError["type"]>,
      { icon: string; colorFn: (s: string) => string }
    >
  )[type];

  const splitter = "=================================================";
  let header = `${icon}  ${chalk.bold.underline(whatHappened.trim())}`;
  if (stack) {
    header +=
      "\n" +
      [...(new Error().stack?.split("\n").slice(1).filter(Boolean) || [])].join(
        "\n"
      );
  }

  let toFixNowStr =
    (Array.isArray(toFixNow)
      ? toFixNow
          .map((s) => s.trim())
          .filter(Boolean)
          .map((s, i) => `\t${i + 1}. ${s}`)
          .join("\n")
      : toFixNow?.trim()) ?? "";

  if (Array.isArray(toFixNow) && toFixNowStr) {
    toFixNowStr = `To fix this, you can take one of the following courses of action:\n\n${toFixNowStr}`;
  }

  let body = [reassurance?.trim(), why?.trim(), consequences?.trim()]
    .filter(Boolean)
    .join(" ");
  body += body ? `\n\n${toFixNowStr}` : toFixNowStr;

  const trailer = [otherwise?.trim()].filter(Boolean).join(" ");

  const message = [
    splitter,
    header,
    body,
    trailer,
    code ? `Code: ${code}` : "",
    splitter,
  ]
    .filter(Boolean)
    .join("\n\n");

  return colorFn(message);
};

export const functionStoppedRunningErr = (code: ErrCode) => {
  return prettyError({
    whatHappened: "Your function was stopped from running",
    why: "We detected a mix of asynchronous logic, some using step tooling and some not.",
    consequences:
      "This can cause unexpected behaviour when a function is paused and resumed and is therefore strongly discouraged; we stopped your function to ensure nothing unexpected happened!",
    stack: true,
    toFixNow:
      "Ensure that your function is either entirely step-based or entirely non-step-based, by either wrapping all asynchronous logic in `step.run()` calls or by removing all `step.*()` calls.",
    otherwise:
      "For more information on why step functions work in this manner, see https://www.inngest.com/docs/functions/multi-step#gotchas",
    code,
  });
};

export const fixEventKeyMissingSteps = [
  "Set the `INNGEST_EVENT_KEY` environment variable",
  `Pass a key to the \`new Inngest()\` constructor using the \`${
    "eventKey" satisfies keyof ClientOptions
  }\` option`,
  `Use \`inngest.${"setEventKey" satisfies keyof Inngest}()\` at runtime`,
];

/**
 * An error that, when thrown, indicates internally that an outgoing operation
 * contains an error.
 *
 * We use this because serialized `data` sent back to Inngest may differ from
 * the error instance itself due to middleware.
 *
 * @internal
 */
export class OutgoingOpError extends Error {
  public readonly op: OutgoingOp;

  constructor(op: OutgoingOp) {
    super("OutgoingOpError");
    this.op = op;
  }
}
