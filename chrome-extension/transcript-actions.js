function requireMarkdown(markdown) {
    if (typeof markdown !== "string" || !markdown.trim()) {
        throw new Error("Нет текста для экспорта.");
    }
}

export async function copyMarkdownToClipboard(markdown, clipboard = navigator.clipboard) {
    requireMarkdown(markdown);
    if (!clipboard?.writeText) {
        throw new Error("Браузер не предоставляет доступ к буферу обмена.");
    }
    await clipboard.writeText(markdown);
}

export function downloadMarkdown(markdown, filename, {
    documentObject = document,
    urlObject = URL,
    BlobType = Blob,
    schedule = (callback) => setTimeout(callback, 0),
} = {}) {
    requireMarkdown(markdown);
    const blob = new BlobType([markdown], { type: "text/markdown;charset=utf-8" });
    const objectUrl = urlObject.createObjectURL(blob);
    const anchor = documentObject.createElement("a");
    anchor.href = objectUrl;
    anchor.download = filename;
    anchor.hidden = true;
    documentObject.body.append(anchor);
    anchor.click();
    schedule(() => {
        urlObject.revokeObjectURL(objectUrl);
        anchor.remove();
    });
    return filename;
}
