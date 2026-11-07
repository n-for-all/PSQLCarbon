/**
 * Fetches a file and saves it, errors from the server come back as their message.
 * The file name comes from the response's Content-Disposition header.
 */
export async function downloadFile(url: string, init?: RequestInit, onProgress?: (bytes: number) => void) {
	const response = await fetch(url, init);
	if (!response.ok || !response.body) {
		const error = await response.json().catch(() => ({}));
		throw new Error(error.message || "The download failed");
	}
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	for (;;) {
		const { value, done } = await reader.read();
		if (done) break;
		chunks.push(value);
		bytes += value.length;
		onProgress?.(bytes);
	}
	const blob = new Blob(chunks as BlobPart[]);
	const name = /filename="([^"]+)"/.exec(response.headers.get("Content-Disposition") || "")?.[1] || "download";
	const href = URL.createObjectURL(blob);
	const a = document.createElement("a");
	a.href = href;
	a.download = name;
	a.click();
	setTimeout(() => URL.revokeObjectURL(href), 5000);
	return { name, bytes, blob, headers: response.headers };
}

export const formatBytes = (bytes: number) =>
	bytes < 1024 ? `${bytes} B` : bytes < 1024 ** 2 ? `${(bytes / 1024).toFixed(1)} KB` : bytes < 1024 ** 3 ? `${(bytes / 1024 ** 2).toFixed(1)} MB` : `${(bytes / 1024 ** 3).toFixed(2)} GB`;
