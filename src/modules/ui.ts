import { getLocaleID, getString } from "../utils/locale";
import {
  copyDefaultAction,
  copyPaperFullTexts,
  copyPaperRefs,
  copyReaderAnnotations,
  copyReaderSelection,
  copySourceFiles,
} from "./actions";

let readerToolbarRegistered = false;

export function registerMenus(): void {
  const icon = `chrome://${addon.data.config.addonRef}/content/icons/favicon@0.5x.png`;

  Zotero.MenuManager.registerMenu({
    menuID: `${addon.data.config.addonRef}-item-submenu`,
    pluginID: addon.data.config.addonID,
    target: "main/library/item",
    menus: [
      {
        menuType: "submenu",
        l10nID: getLocaleID("itemmenu-root"),
        icon,
        menus: [
          {
            menuType: "menuitem",
            l10nID: getLocaleID("itemmenu-copy-file"),
            onCommand: (_ev, context) => void copySourceFiles(context?.items),
          },
          {
            menuType: "menuitem",
            l10nID: getLocaleID("itemmenu-copy-ref"),
            onCommand: (_ev, context) => void copyPaperRefs(context?.items),
          },
          {
            menuType: "menuitem",
            l10nID: getLocaleID("itemmenu-copy-fulltext"),
            onCommand: (_ev, context) =>
              void copyPaperFullTexts(context?.items),
          },
        ],
      },
    ],
  });

  Zotero.MenuManager.registerMenu({
    menuID: `${addon.data.config.addonRef}-tab-submenu`,
    pluginID: addon.data.config.addonID,
    target: "main/tab",
    menus: [
      {
        menuType: "submenu",
        l10nID: getLocaleID("itemmenu-root"),
        icon,
        onShowing: (_ev, context) => {
          context.setVisible(Boolean(context.items?.length));
        },
        menus: [
          {
            menuType: "menuitem",
            l10nID: getLocaleID("itemmenu-copy-file"),
            onCommand: (_ev, context) => void copySourceFiles(context?.items),
          },
          {
            menuType: "menuitem",
            l10nID: getLocaleID("itemmenu-copy-ref"),
            onCommand: (_ev, context) => void copyPaperRefs(context?.items),
          },
          {
            menuType: "menuitem",
            l10nID: getLocaleID("itemmenu-copy-fulltext"),
            onCommand: (_ev, context) =>
              void copyPaperFullTexts(context?.items),
          },
        ],
      },
    ],
  });
}

function createToolbarButtons(
  doc: Document,
  reader: _ZoteroTypes.ReaderInstance,
): HTMLElement {
  const wrap = doc.createElement("div");
  wrap.setAttribute("data-agentcontext-toolbar", "true");
  wrap.style.display = "inline-flex";
  wrap.style.alignItems = "center";
  wrap.style.gap = "4px";
  wrap.style.marginInlineStart = "6px";
  wrap.style.marginInlineEnd = "4px";
  wrap.style.flexShrink = "0";

  const getReaderItem = () =>
    reader.itemID ? Zotero.Items.get(reader.itemID) || undefined : undefined;

  const makeBtn = (label: string, onClick: () => void) => {
    const btn = doc.createElement("button");
    btn.type = "button";
    btn.className = "toolbar-button";
    btn.textContent = label;
    btn.style.cssText =
      "-moz-window-dragging: no-drag; width: auto; min-width: max-content; height: 24px; flex-shrink: 0; display: inline-flex; align-items: center; justify-content: center; white-space: nowrap; padding: 2px 8px; font-size: 11px; border-radius: 4px; border: 1px solid var(--fill-quinary, #ccc); background: var(--material-background, transparent); color: inherit; cursor: pointer; line-height: 1.4; box-sizing: border-box;";
    btn.addEventListener("click", onClick);
    return btn;
  };

  wrap.appendChild(
    makeBtn(getString("reader-toolbar-copy-file"), () => {
      void copySourceFiles(getReaderItem());
    }),
  );
  wrap.appendChild(
    makeBtn(getString("reader-toolbar-copy-ref"), () => {
      void copyPaperRefs(getReaderItem());
    }),
  );

  return wrap;
}

export function registerReaderUI(): void {
  if (!readerToolbarRegistered) {
    readerToolbarRegistered = true;

    Zotero.Reader.registerEventListener(
      "renderToolbar",
      (event) => {
        const { doc, append, reader } = event;
        if (doc.querySelector("[data-agentcontext-toolbar]")) return;
        append(createToolbarButtons(doc, reader));
      },
      addon.data.config.addonID,
    );

    Zotero.Reader.registerEventListener(
      "renderTextSelectionPopup",
      (event) => {
        const { doc, append, reader, params } = event;
        if (!params.annotation?.text) return;

        const btn = doc.createElement("button");
        btn.type = "button";
        btn.className = "toolbar-button wide-button";
        btn.textContent = getString("reader-popup-copy");
        btn.style.cssText =
          "cursor: pointer; font-size: 11px; width: auto; height: auto; white-space: nowrap; padding: 4px 8px;";
        btn.addEventListener("click", () => {
          void copyReaderSelection(reader, params.annotation);
        });
        append(btn);
      },
      addon.data.config.addonID,
    );

    Zotero.Reader.registerEventListener(
      "createAnnotationContextMenu",
      (event) => {
        if (!event.params.ids?.length) return;
        event.append({
          label: getString("reader-popup-copy"),
          onCommand: () => {
            void copyReaderAnnotations(event.reader, event.params.ids);
          },
        });
      },
      addon.data.config.addonID,
    );

    Zotero.Reader.registerEventListener(
      "createViewContextMenu",
      (event) => {
        const { reader, append } = event;
        const getReaderItem = () =>
          reader.itemID
            ? Zotero.Items.get(reader.itemID) || undefined
            : undefined;
        append({
          label: getString("reader-toolbar-copy-file"),
          onCommand: () => {
            void copySourceFiles(getReaderItem());
          },
        });
        append({
          label: getString("reader-toolbar-copy-ref"),
          onCommand: () => {
            void copyPaperRefs(getReaderItem());
          },
        });
      },
      addon.data.config.addonID,
    );
  }

  for (const reader of Zotero.Reader._readers || []) {
    const doc = reader._iframeWindow?.document;
    if (!doc || doc.querySelector("[data-agentcontext-toolbar]")) continue;
    const container =
      doc.querySelector(".toolbar .end .custom-sections") ||
      doc.querySelector(".custom-sections");
    if (!container) continue;
    const section = doc.createElement("div");
    section.className = "section";
    section.appendChild(createToolbarButtons(doc, reader));
    container.appendChild(section);
  }
}

export function cleanupReaderUI(): void {
  readerToolbarRegistered = false;
  for (const reader of Zotero.Reader._readers || []) {
    const doc = reader._iframeWindow?.document;
    if (!doc) continue;
    doc
      .querySelectorAll("[data-agentcontext-toolbar]")
      .forEach((el: Element) => {
        const parent = el.parentElement;
        el.remove();
        if (
          parent?.classList.contains("section") &&
          parent.children.length === 0
        ) {
          parent.remove();
        }
      });
  }
}

export function registerShortcuts(): void {
  ztoolkit.Keyboard.register((ev, keyOptions) => {
    if (keyOptions.keyboard?.equals("alt,shift,c")) {
      ev.preventDefault();
      void copyDefaultAction();
    }
  });
}
