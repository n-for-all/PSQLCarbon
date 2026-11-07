import * as React from "react";

interface ResizableOptions {
	/** localStorage key, only widths the user dragged to are saved */
	storageKey: string;
	defaultWidth: number;
	min: number;
	max: number;
	/** Which edge of the panel the handle is on, dragging it away from the panel makes it wider */
	edge: "left" | "right";
}

export function useResizable({ storageKey, defaultWidth, min, max, edge }: ResizableOptions) {
	const [width, setWidth] = React.useState(defaultWidth);
	const [resizing, setResizing] = React.useState(false);

	React.useEffect(() => {
		try {
			const saved = parseInt(localStorage.getItem(storageKey) || "", 10);
			if (saved >= min && saved <= max) setWidth(saved);
		} catch {
			// storage is only a convenience
		}
	}, [storageKey, min, max]);

	const startResizing = React.useCallback(
		(event: React.MouseEvent) => {
			event.preventDefault();
			const startX = event.clientX;
			const startWidth = width;
			let current = startWidth;
			setResizing(true);
			document.body.style.cursor = "col-resize";
			document.body.style.userSelect = "none";

			const onMouseMove = (moveEvent: MouseEvent) => {
				const delta = edge === "right" ? moveEvent.clientX - startX : startX - moveEvent.clientX;
				current = Math.max(min, Math.min(max, startWidth + delta));
				setWidth(current);
			};
			const onMouseUp = () => {
				document.removeEventListener("mousemove", onMouseMove);
				document.removeEventListener("mouseup", onMouseUp);
				document.body.style.cursor = "";
				document.body.style.userSelect = "";
				setResizing(false);
				try {
					localStorage.setItem(storageKey, String(current));
				} catch {
					// ignore
				}
			};

			document.addEventListener("mousemove", onMouseMove);
			document.addEventListener("mouseup", onMouseUp);
		},
		[width, edge, min, max, storageKey]
	);

	return { width, resizing, startResizing };
}
