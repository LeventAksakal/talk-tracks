// What Media Chrome needs of the DOM that happy-dom (the tests' DOM) lacks: Element.part (CSS Shadow Parts), which
// its menus call while building items, and a CSS parser that takes ::slotted() rules. Every browser the player
// supports has both, so this does nothing there. Imported before media-chrome.

if (typeof CSSStyleSheet !== "undefined") {
  let parsesSlotted = true;
  try {
    new CSSStyleSheet().insertRule("::slotted(a){}");
  } catch {
    parsesSlotted = false;
  }
  if (!parsesSlotted) {
    const insert = CSSStyleSheet.prototype.insertRule;
    CSSStyleSheet.prototype.insertRule = function (rule: string, index?: number): number {
      try {
        return insert.call(this, rule, index);
      } catch {
        // A rule this parser cannot read stands in as an empty one, so Media Chrome can still set its style.
        return insert.call(this, `.tt-unparsed${rule.slice(rule.indexOf("{"))}`, index);
      }
    };
  }
}

if (typeof Element !== "undefined" && !("part" in Element.prototype)) {
  const parts = new WeakMap<Element, DOMTokenList>();
  Object.defineProperty(Element.prototype, "part", {
    configurable: true,
    get(this: Element): DOMTokenList {
      let list = parts.get(this);
      if (!list) {
        const read = () => (this.getAttribute("part") ?? "").split(/\s+/).filter(Boolean);
        const write = (tokens: string[]) => this.setAttribute("part", [...new Set(tokens)].join(" "));
        list = {
          add: (...t: string[]) => write([...read(), ...t]),
          remove: (...t: string[]) => write(read().filter((x) => !t.includes(x))),
          contains: (t: string) => read().includes(t),
          toggle: (t: string, force?: boolean) => {
            const on = force ?? !read().includes(t);
            write(on ? [...read(), t] : read().filter((x) => x !== t));
            return on;
          },
          get value() {
            return read().join(" ");
          },
          get length() {
            return read().length;
          },
        } as unknown as DOMTokenList;
        parts.set(this, list);
      }
      return list;
    },
  });
}
