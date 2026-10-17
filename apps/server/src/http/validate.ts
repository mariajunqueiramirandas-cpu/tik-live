import { zValidator } from "@hono/zod-validator";
import type { ValidationTargets } from "hono";
import type { z } from "zod";
import { problem } from "./errors";

/** zod validation that answers in our problem shape (ADR-0003). */
export function valid<T extends z.ZodType, Target extends keyof ValidationTargets>(target: Target, schema: T) {
  return zValidator(target, schema, (result, c) => {
    if (!result.success) {
      const issues = result.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }));
      return problem(c, 400, "invalid_input", issues[0]?.message ?? "Alguns campos não são válidos.", issues);
    }
  });
}
