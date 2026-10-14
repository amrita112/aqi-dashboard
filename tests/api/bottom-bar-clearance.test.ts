/**
 * Nothing may sit underneath the tab bar.
 *
 * The bar is `position: fixed` over the bottom ~80px of the viewport, and a
 * `sticky bottom-0` element pins to the SCROLLPORT rather than to its padded
 * container — so it lands under the bar, not above it.
 *
 * That is not hypothetical. The Ask tab's question box was `sticky bottom-0`,
 * which put the entire input underneath the tab bar: on an iPhone the tab
 * showed a title, a stretch of empty space, two footnotes, and no way to ask
 * anything at all. It had been wrong from the start and only became invisible
 * when the tab bar went from 95% opaque to solid, so the box stopped faintly
 * showing through. A user recorded it before anyone noticed.
 *
 * Source assertions, because this is a layout rule that unit tests cannot
 * observe — the alternative is a browser, and until there is one these at
 * least fail loudly when the pattern comes back.
 */

import { describe, it, expect } from "vitest";
import { readFile, readdir } from "node:fs/promises";

/**
 * Source with comments removed.
 *
 * Without this the test matched its own explanation: the comment in
 * AskScreen.tsx that says "100dvh, NOT 100vh" contains the forbidden string,
 * so documenting the fix failed the test for the fix. A rule about code has
 * to read only the code.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

async function componentSources(): Promise<[string, string][]> {
  const names = (await readdir("components")).filter((f) => f.endsWith(".tsx"));
  return Promise.all(
    names.map(
      async (n) => [n, stripComments(await readFile(`components/${n}`, "utf8"))] as [string, string],
    ),
  );
}

describe("clearance for the fixed tab bar", () => {
  it("has no bottom-pinned element flush with the viewport on a phone", async () => {
    for (const [name, src] of await componentSources()) {
      // The tab bar itself is the bar, so it is the one thing allowed there.
      if (name === "TabBar.tsx") continue;
      for (const cls of ["sticky bottom-0", "fixed bottom-0"]) {
        expect(src.includes(cls), `${name} pins to ${cls}, which is under the tab bar`).toBe(false);
      }
    }
  });

  it("sizes full-height columns with dvh, not vh", async () => {
    // On iOS, 100vh is the viewport as it would be WITHOUT browser chrome —
    // taller than the screen — so a column sized to it hangs off the bottom
    // and takes whatever sits at its end with it.
    for (const [name, src] of await componentSources()) {
      expect(src.includes("100vh"), `${name} uses 100vh; use 100dvh`).toBe(false);
    }
  });
});
