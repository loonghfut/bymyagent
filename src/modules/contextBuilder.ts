import { getPref } from "../utils/prefs";

export type CopyMode = "file" | "ref" | "fulltext";

export interface PaperContext {
  key: string;
  title: string;
  authors: string[];
  year: string;
  venue: string;
  doi: string;
  abstract: string;
  zoteroUri: string;
  pdfPath: string;
  currentPage?: number;
  fullText: string;
}

export interface TargetResolution {
  items: Zotero.Item[];
  preferredAttachmentByIndex: Map<number, number>;
  currentPage?: number;
}

export function getActiveReader(): _ZoteroTypes.ReaderInstance | undefined {
  try {
    const tabID = Zotero.getMainWindow()?.Zotero_Tabs?.selectedID;
    if (!tabID) return undefined;
    return Zotero.Reader.getByTabID(tabID);
  } catch {
    return undefined;
  }
}

export function normalizeToParentItem(item: Zotero.Item): Zotero.Item {
  if (item.isAttachment() || item.isNote() || item.isAnnotation()) {
    const parentID = item.parentItemID;
    if (parentID) {
      const parent = Zotero.Items.get(parentID);
      if (parent) return parent;
    }
  }
  return item;
}

function buildTargetList(rawList: Zotero.Item[]): {
  items: Zotero.Item[];
  preferredAttachmentByIndex: Map<number, number>;
} {
  const seen = new Set<string>();
  const items: Zotero.Item[] = [];
  const preferredAttachmentByIndex = new Map<number, number>();

  for (const raw of rawList) {
    if (!raw) continue;
    const parent = normalizeToParentItem(raw);
    const dedupKey = raw.isAttachment() ? `att:${raw.id}` : `item:${parent.id}`;
    if (!seen.has(dedupKey)) {
      seen.add(dedupKey);
      const idx = items.length;
      items.push(parent);
      if (raw.isAttachment()) {
        preferredAttachmentByIndex.set(idx, raw.id);
      }
    }
  }

  return { items, preferredAttachmentByIndex };
}

/**
 * Resolve target items from explicit item(s), the active reader tab, or library multi-selection.
 */
export function resolveCurrentTargets(
  explicitInput?: Zotero.Item | Zotero.Item[],
): TargetResolution {
  const rawList = Array.isArray(explicitInput)
    ? explicitInput
    : explicitInput
      ? [explicitInput]
      : [];

  if (rawList.length > 0) {
    const { items, preferredAttachmentByIndex } = buildTargetList(rawList);
    const reader = getActiveReader();
    let currentPage: number | undefined;

    if (reader?.itemID && items.length > 0) {
      const first = items[0];
      const readerAttID = reader.itemID;
      let isSameReader =
        readerAttID === first.id ||
        preferredAttachmentByIndex.get(0) === readerAttID;
      if (!isSameReader && first.isRegularItem()) {
        try {
          isSameReader = first.getAttachments().includes(readerAttID);
        } catch {
          isSameReader = false;
        }
      }
      if (isSameReader) {
        if (!preferredAttachmentByIndex.has(0)) {
          preferredAttachmentByIndex.set(0, readerAttID);
        }
        if (reader.state?.pageIndex !== undefined) {
          currentPage = reader.state.pageIndex + 1;
        }
      }
    }

    return { items, preferredAttachmentByIndex, currentPage };
  }

  const reader = getActiveReader();
  if (reader?.itemID) {
    const att = Zotero.Items.get(reader.itemID);
    if (att) {
      const preferredAttachmentByIndex = new Map<number, number>();
      preferredAttachmentByIndex.set(0, att.id);
      return {
        items: [normalizeToParentItem(att)],
        preferredAttachmentByIndex,
        currentPage:
          reader.state?.pageIndex !== undefined
            ? reader.state.pageIndex + 1
            : undefined,
      };
    }
  }

  const selected = Zotero.getActiveZoteroPane()?.getSelectedItems() || [];
  const { items, preferredAttachmentByIndex } = buildTargetList(selected);
  return { items, preferredAttachmentByIndex };
}

function getSafeField(item: Zotero.Item, field: string): string {
  try {
    const val = item.getField(field);
    return val ? String(val).trim() : "";
  } catch {
    return "";
  }
}

function extractAuthors(item: Zotero.Item): string[] {
  if (!item.isRegularItem()) return [];
  try {
    const creators = item.getCreators() || [];
    return creators
      .map((c) => {
        if (c.lastName && c.firstName) return `${c.firstName} ${c.lastName}`;
        return c.lastName || c.firstName || "";
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

export async function findPrimaryAttachment(
  item: Zotero.Item,
  preferredAttachmentID?: number,
): Promise<Zotero.Item | undefined> {
  if (preferredAttachmentID) {
    const preferred = Zotero.Items.get(preferredAttachmentID);
    if (preferred && preferred.isAttachment()) return preferred;
  }
  if (item.isAttachment()) return item;
  if (!item.isRegularItem()) return undefined;

  let attIDs: number[];
  try {
    attIDs = item.getAttachments();
  } catch {
    return undefined;
  }
  if (!attIDs.length) return undefined;

  const attachments = attIDs
    .map((id) => Zotero.Items.get(id))
    .filter((a): a is Zotero.Item => Boolean(a));

  const pdf = attachments.find(
    (a) => a.attachmentContentType === "application/pdf",
  );
  if (pdf) return pdf;

  const epub = attachments.find(
    (a) => a.attachmentContentType === "application/epub+zip",
  );
  if (epub) return epub;

  return attachments[0];
}

/**
 * Resolve existing local file paths for one or more items (supports multi-select).
 */
export async function resolvePdfPaths(
  items: Zotero.Item[],
  preferredAttachmentByIndex?: Map<number, number>,
): Promise<{ paths: string[]; missingCount: number }> {
  const paths: string[] = [];
  const seen = new Set<string>();
  let missingCount = 0;

  for (let i = 0; i < items.length; i++) {
    const att = await findPrimaryAttachment(
      items[i],
      preferredAttachmentByIndex?.get(i),
    );
    const filePath = att ? await att.getFilePathAsync() : false;
    if (
      typeof filePath === "string" &&
      filePath &&
      (await IOUtils.exists(filePath))
    ) {
      if (!seen.has(filePath)) {
        seen.add(filePath);
        paths.push(filePath);
      }
    } else {
      missingCount++;
    }
  }

  return { paths, missingCount };
}

async function readFullTextCache(
  attachment: Zotero.Item,
  maxChars: number,
): Promise<string> {
  try {
    let cacheFile = Zotero.Fulltext.getItemCacheFile(attachment);
    if (
      (!cacheFile || !cacheFile.exists()) &&
      attachment.attachmentContentType === "application/pdf"
    ) {
      const filePath = await attachment.getFilePathAsync();
      if (
        typeof filePath === "string" &&
        filePath &&
        (await IOUtils.exists(filePath))
      ) {
        await Zotero.Fulltext.indexPDF(filePath, attachment.id, true);
        cacheFile = Zotero.Fulltext.getItemCacheFile(attachment);
      }
    }
    if (!cacheFile || !cacheFile.exists()) return "";
    const content = await Zotero.File.getContentsAsync(cacheFile, "UTF-8");
    if (typeof content !== "string") return "";
    const trimmed = content.trim();
    if (maxChars > 0 && trimmed.length > maxChars) {
      return (
        trimmed.slice(0, maxChars) +
        `\n\n[... truncated at ${maxChars} characters ...]`
      );
    }
    return trimmed;
  } catch (e) {
    ztoolkit.log("Failed to read fulltext cache", e);
    return "";
  }
}

export async function extractPaperContext(
  rawItem: Zotero.Item,
  options: {
    preferredAttachmentID?: number;
    currentPage?: number;
    includeFullText?: boolean;
  } = {},
): Promise<PaperContext> {
  const item = normalizeToParentItem(rawItem);
  const maxFullTextChars = Number(getPref("maxFullTextChars")) || 40000;
  const attachment = await findPrimaryAttachment(
    item,
    options.preferredAttachmentID,
  );

  let pdfPath = "";
  if (attachment) {
    const resolved = await attachment.getFilePathAsync();
    if (typeof resolved === "string") pdfPath = resolved;
  }

  const dateStr = getSafeField(item, "date");
  const yearMatch = dateStr.match(/\b(19|20)\d{2}\b/);
  const year = yearMatch ? yearMatch[0] : dateStr;

  const venue =
    getSafeField(item, "publicationTitle") ||
    getSafeField(item, "conferenceName") ||
    getSafeField(item, "proceedingsTitle") ||
    getSafeField(item, "bookTitle") ||
    getSafeField(item, "university") ||
    "";

  const fullText =
    options.includeFullText && attachment
      ? await readFullTextCache(attachment, maxFullTextChars)
      : "";

  const lib = Zotero.Libraries.get(item.libraryID);
  const libraryPrefix =
    item.libraryID === Zotero.Libraries.userLibraryID
      ? "library"
      : `groups/${(lib && "groupID" in lib ? lib.groupID : undefined) || item.libraryID}`;

  return {
    key: item.key,
    title:
      getSafeField(item, "title") ||
      (attachment ? getSafeField(attachment, "title") : "") ||
      "Untitled",
    authors: extractAuthors(item),
    year,
    venue,
    doi: getSafeField(item, "DOI"),
    abstract: getSafeField(item, "abstractNote"),
    zoteroUri: `zotero://select/${libraryPrefix}/items/${item.key}`,
    pdfPath,
    currentPage: options.currentPage,
    fullText,
  };
}

export function formatPaperRef(ctx: PaperContext): string {
  const firstAuthor = ctx.authors[0] || "Unknown";
  const authorYear = ctx.year ? `${firstAuthor} (${ctx.year})` : firstAuthor;
  const lines: string[] = [];
  if (ctx.pdfPath) {
    const quoted = ctx.pdfPath.includes(" ")
      ? `@"${ctx.pdfPath}"`
      : `@${ctx.pdfPath}`;
    lines.push(`- **PDF**: ${quoted}`);
  }
  lines.push(`- **Title**: ${ctx.title} — ${authorYear}`);
  if (ctx.venue) lines.push(`- **Venue**: ${ctx.venue}`);
  if (ctx.currentPage) lines.push(`- **Current Page**: p.${ctx.currentPage}`);
  if (ctx.doi) lines.push(`- **DOI**: ${ctx.doi}`);
  if (ctx.abstract) lines.push(`- **Abstract**: ${ctx.abstract}`);
  return lines.join("\n");
}

export function formatPaperFullText(ctx: PaperContext): string {
  const lines = [formatPaperRef(ctx)];
  if (ctx.fullText) {
    lines.push("");
    lines.push("## Full Text");
    lines.push(ctx.fullText);
  }
  return lines.join("\n");
}
