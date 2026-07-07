// @vitest-environment node
//
// The Loom builder persona — the DEFAULT system prompt for embedded-agent mode. Guards two things:
//   1. resolveSystemPrompt precedence: explicit override → env fallback → the built-in default persona.
//   2. the persona text stays Loom-flavored — no residual Lovable branding, `lov-` tags, Vite, or Supabase,
//      and it keeps the load-bearing Loom stack markers (Next.js, @loom/ds, FastAPI, Loom Plugins).
import { describe, it, expect } from "vitest";
import {
  LOOM_BUILDER_SYSTEM_PROMPT,
  SYSTEM_PROMPT_ENV,
  resolveSystemPrompt,
} from "../src/agent/system-prompt";

describe("resolveSystemPrompt precedence", () => {
  it("defaults to the Loom builder persona when nothing is supplied", () => {
    expect(resolveSystemPrompt(undefined, {})).toBe(LOOM_BUILDER_SYSTEM_PROMPT);
    // Blank/whitespace-only never silently disables the persona.
    expect(resolveSystemPrompt("   ", {})).toBe(LOOM_BUILDER_SYSTEM_PROMPT);
  });

  it("an explicit caller value wins over both the env var and the default", () => {
    const explicit = "You are a haiku-only agent.";
    expect(resolveSystemPrompt(explicit, {})).toBe(explicit);
    expect(resolveSystemPrompt(explicit, { [SYSTEM_PROMPT_ENV]: "env prompt" })).toBe(explicit);
  });

  it("falls back to the env var when no explicit value is given", () => {
    const envPrompt = "You are the env-configured builder.";
    expect(resolveSystemPrompt(undefined, { [SYSTEM_PROMPT_ENV]: envPrompt })).toBe(envPrompt);
    // A blank explicit still yields the env value (treated as absent).
    expect(resolveSystemPrompt("", { [SYSTEM_PROMPT_ENV]: envPrompt })).toBe(envPrompt);
  });
});

describe("LOOM_BUILDER_SYSTEM_PROMPT content", () => {
  const lower = LOOM_BUILDER_SYSTEM_PROMPT.toLowerCase();

  it("carries no residual Lovable branding or stack", () => {
    expect(lower).not.toContain("lovable");
    expect(lower).not.toContain("lov-");
    expect(lower).not.toContain("supabase");
    expect(lower).not.toContain("shadcn");
    expect(lower).not.toContain("tailwind");
    // Vite / VITE_* — word-boundary match so it never trips on unrelated substrings.
    expect(LOOM_BUILDER_SYSTEM_PROMPT).not.toMatch(/\bvite\b/i);
    expect(LOOM_BUILDER_SYSTEM_PROMPT).not.toMatch(/vite_/i);
    // No "Current date:" line (it was Lovable-specific and would go stale).
    expect(lower).not.toContain("current date");
  });

  it("frames the Loom stack: Next.js, the Loom Design System, FastAPI, and Loom Plugins", () => {
    expect(LOOM_BUILDER_SYSTEM_PROMPT).toContain("Next.js");
    expect(LOOM_BUILDER_SYSTEM_PROMPT).toContain("@loom/ds");
    expect(LOOM_BUILDER_SYSTEM_PROMPT).toContain("FastAPI");
    expect(LOOM_BUILDER_SYSTEM_PROMPT).toContain("Loom Plugins");
    // Never claims Next.js is unsupported (the biggest adaptation from the source prompt).
    expect(lower).not.toContain("next.js is unsupported");
  });

  it("keeps the harness's real affordances: marks-as-context + live preview", () => {
    expect(LOOM_BUILDER_SYSTEM_PROMPT).toContain("file:line:col");
    expect(lower).toContain("live preview");
    expect(lower).toContain("region screenshot");
  });
});
