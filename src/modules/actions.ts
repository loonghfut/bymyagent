import { getString } from "../utils/locale";
import { getPref } from "../utils/prefs";
import {
  CopyMode,
  extractPaperContext,
  formatPaperFullText,
  formatPaperRef,
  resolveCurrentTargets,
  resolvePdfPaths,
} from "./contextBuilder";

function showNotice(
  text: string,
  type: "success" | "fail" | "default" = "default",
): void {
  new ztoolkit.ProgressWindow(addon.data.config.addonName, {
    closeOnClick: true,
    closeTime: 2500,
  })
    .createLine({
      text,
      type,
      progress: 100,
    })
    .show();
}

function copyTextToClipboard(text: string): void {
  new ztoolkit.Clipboard().addText(text, "text/unicode").copy();
}

function toBase64Utf16LE(str: string): string {
  const bytes = new Uint8Array(str.length * 2);
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    bytes[i * 2] = code & 0xff;
    bytes[i * 2 + 1] = code >> 8;
  }
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  const btoaFn =
    typeof btoa === "function" ? btoa : Zotero.getMainWindow().btoa;
  return btoaFn(binary);
}

async function copyMultipleFilesToClipboard(paths: string[]): Promise<void> {
  if (Zotero.isWin) {
    const quoted = paths.map((p) => `'${p.replace(/'/g, "''")}'`).join(",");
    const psScript = `Set-Clipboard -LiteralPath @(${quoted})`;
    const encoded = toBase64Utf16LE(psScript);
    const sysRoot = Services.env.get("SystemRoot") || "C:\\Windows";
    const psExe = PathUtils.join(
      sysRoot,
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
    const psArgs = [
      "-NoProfile",
      "-NonInteractive",
      "-Sta",
      "-WindowStyle",
      "Hidden",
      "-EncodedCommand",
      encoded,
    ];

    try {
      const { Subprocess } = ChromeUtils.importESModule(
        "resource://gre/modules/Subprocess.sys.mjs",
      );
      const proc = await Subprocess.call({
        command: psExe,
        arguments: psArgs,
      });
      const { exitCode } = await proc.wait();
      if (exitCode !== 0) {
        throw new Error(`PowerShell exited with code ${exitCode}`);
      }
      return;
    } catch (subErr) {
      ztoolkit.log(
        "Subprocess.call failed, falling back to Utilities.Internal.exec",
        subErr,
      );
      const result = await Zotero.Utilities.Internal.exec(psExe, psArgs);
      if (result instanceof Error) throw result;
      return;
    }
  }

  if (paths.length === 1) {
    new ztoolkit.Clipboard().addFile(paths[0]).copy();
    return;
  }

  if (Zotero.isMac) {
    const posixList = paths
      .map((p) => `POSIX file "${p.replace(/"/g, '\\"')}"`)
      .join(", ");
    const result = await Zotero.Utilities.Internal.exec("/usr/bin/osascript", [
      "-e",
      `set the clipboard to {${posixList}}`,
    ]);
    if (result instanceof Error) throw result;
    return;
  }

  // Linux fallback: copy text/uri-list via xclip or wl-copy if available, otherwise first file
  const uriList = paths.map((p) => `file://${encodeURI(p)}`).join("\n");
  const shCmd = `printf '%s' '${uriList.replace(/'/g, "'\\''")}' | (wl-copy -t text/uri-list 2>/dev/null || xclip -selection clipboard -t text/uri-list)`;
  const result = await Zotero.Utilities.Internal.exec("/bin/sh", ["-c", shCmd]);
  if (result instanceof Error) {
    new ztoolkit.Clipboard().addFile(paths[0]).copy();
  }
}

export async function copySourceFiles(
  explicitInput?: Zotero.Item | Zotero.Item[],
): Promise<void> {
  const { items, preferredAttachmentByIndex } =
    resolveCurrentTargets(explicitInput);
  if (!items.length) {
    showNotice(getString("no-item-selected"), "fail");
    return;
  }

  const { paths, missingCount } = await resolvePdfPaths(
    items,
    preferredAttachmentByIndex,
  );
  if (!paths.length) {
    showNotice(getString("no-pdf-found"), "fail");
    return;
  }

  try {
    await copyMultipleFilesToClipboard(paths);
    if (missingCount > 0) {
      showNotice(
        getString("copied-files-partial", {
          args: { count: paths.length, missing: missingCount },
        }),
        "success",
      );
    } else {
      showNotice(
        getString("copied-files", { args: { count: paths.length } }),
        "success",
      );
    }
  } catch (e: any) {
    showNotice(
      getString("copy-failed", { args: { error: String(e?.message || e) } }),
      "fail",
    );
  }
}

export async function copyPaperRefs(
  explicitInput?: Zotero.Item | Zotero.Item[],
): Promise<void> {
  const { items, preferredAttachmentByIndex, currentPage } =
    resolveCurrentTargets(explicitInput);
  if (!items.length) {
    showNotice(getString("no-item-selected"), "fail");
    return;
  }

  const chunks: string[] = [];
  for (let i = 0; i < items.length; i++) {
    const ctx = await extractPaperContext(items[i], {
      preferredAttachmentID: preferredAttachmentByIndex.get(i),
      currentPage: i === 0 ? currentPage : undefined,
      includeFullText: false,
    });
    chunks.push(formatPaperRef(ctx));
  }

  copyTextToClipboard(chunks.join("\n\n---\n\n"));
  showNotice(getString("copied-ref"), "success");
}

export async function copyPaperFullTexts(
  explicitInput?: Zotero.Item | Zotero.Item[],
): Promise<void> {
  const { items, preferredAttachmentByIndex, currentPage } =
    resolveCurrentTargets(explicitInput);
  if (!items.length) {
    showNotice(getString("no-item-selected"), "fail");
    return;
  }

  const chunks: string[] = [];
  let hasAnyFullText = false;
  for (let i = 0; i < items.length; i++) {
    const ctx = await extractPaperContext(items[i], {
      preferredAttachmentID: preferredAttachmentByIndex.get(i),
      currentPage: i === 0 ? currentPage : undefined,
      includeFullText: true,
    });
    if (ctx.fullText) hasAnyFullText = true;
    chunks.push(formatPaperFullText(ctx));
  }

  copyTextToClipboard(chunks.join("\n\n---\n\n"));
  showNotice(
    getString(hasAnyFullText ? "copied-fulltext" : "copied-fulltext-empty"),
    hasAnyFullText ? "success" : "default",
  );
}

export async function copyDefaultAction(
  explicitInput?: Zotero.Item | Zotero.Item[],
): Promise<void> {
  const mode = (getPref("copyMode") as CopyMode) || "file";
  if (mode === "ref") {
    await copyPaperRefs(explicitInput);
  } else if (mode === "fulltext") {
    await copyPaperFullTexts(explicitInput);
  } else {
    await copySourceFiles(explicitInput);
  }
}

function formatPassageWithSource(
  passages: string[],
  title: string,
  firstAuthor: string,
  year: string,
  pdfPath: string,
): string {
  return [
    ...passages,
    "",
    `— *${title}* (${firstAuthor}, ${year || "n.d."})`,
    pdfPath ? `PDF: \`${pdfPath}\`` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export async function copyReaderSelection(
  reader: _ZoteroTypes.ReaderInstance,
  annotation: _ZoteroTypes.Annotations.AnnotationJson,
): Promise<void> {
  const selectedText = (annotation.text || "").trim();
  if (!selectedText) return;

  const rawAtt = reader.itemID ? Zotero.Items.get(reader.itemID) : undefined;
  const att = rawAtt || undefined;
  const pageLabel = annotation.pageLabel || (reader.state?.pageIndex ?? 0) + 1;

  if (!att) {
    copyTextToClipboard(selectedText);
    showNotice(getString("copied-selection"), "success");
    return;
  }

  const ctx = await extractPaperContext(att, {
    preferredAttachmentID: att.id,
    currentPage: Number(pageLabel) || undefined,
    includeFullText: false,
  });

  const firstAuthor = ctx.authors[0] || "Unknown";
  const quote = `> ${selectedText.replace(/\n+/g, "\n> ")} (p.${pageLabel})`;
  const formatted = formatPassageWithSource(
    [quote],
    ctx.title,
    firstAuthor,
    ctx.year,
    ctx.pdfPath,
  );

  copyTextToClipboard(formatted);
  showNotice(getString("copied-selection"), "success");
}

export async function copyReaderAnnotations(
  reader: _ZoteroTypes.ReaderInstance,
  annotationKeys: string[],
): Promise<void> {
  const rawAtt = reader.itemID ? Zotero.Items.get(reader.itemID) : undefined;
  const att = rawAtt || undefined;
  if (!att || !annotationKeys.length) return;

  const passages: string[] = [];
  for (const key of annotationKeys) {
    const ann = Zotero.Items.getByLibraryAndKey(att.libraryID, key);
    if (!ann) continue;
    const text = (ann.annotationText || "").trim();
    const comment = (ann.annotationComment || "").trim();
    const pageLabel = ann.annotationPageLabel || "";
    if (!text && !comment) continue;

    const lines: string[] = [];
    if (text) {
      const pageSuffix = pageLabel ? ` (p.${pageLabel})` : "";
      lines.push(`> ${text.replace(/\n+/g, "\n> ")}${pageSuffix}`);
    }
    if (comment) {
      lines.push(`Note: ${comment}`);
    }
    passages.push(lines.join("\n"));
  }

  if (!passages.length) return;

  const ctx = await extractPaperContext(att, {
    preferredAttachmentID: att.id,
    includeFullText: false,
  });

  const firstAuthor = ctx.authors[0] || "Unknown";
  const formatted = formatPassageWithSource(
    [passages.join("\n\n")],
    ctx.title,
    firstAuthor,
    ctx.year,
    ctx.pdfPath,
  );

  copyTextToClipboard(formatted);
  showNotice(getString("copied-selection"), "success");
}
