import { LoaderFunction, redirect } from "@remix-run/node";
import { useLoaderData, useNavigate, useSearchParams } from "@remix-run/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Graph, layout as dagreLayout } from "@dagrejs/dagre";
import { CopyIcon, DownloadIcon, ScreenFullIcon, ZoomInIcon, ZoomOutIcon } from "@primer/octicons-react";
import { LayoutGrid, Sparkles } from "lucide-react";
import db from "~/lib/db";
import { loadDiagramSchema } from "~/lib/schema-diagram.server";
import { MAX_COLUMNS, MAX_TABLES, type DiagramRelation, type DiagramSchema, type DiagramTable, type InferredRelation } from "~/lib/schema-diagram";
import { getSessionConnection } from "~/utils/session.server";
import { Button } from "~/ui/button";
import { DatabaseTabs } from "~/components/database-tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/ui/select";

interface LoaderData extends DiagramSchema {
    database: string;
    error?: string;
}

export const loader: LoaderFunction = async ({ request, params }) => {
    const connection = await getSessionConnection(request);
    if (!connection) throw redirect("/connections");
    const database = params.db!;
    const mongo = await db(connection);
    const pool = mongo.getPool(database);
    if (!pool) {
        return Response.json({ database, schema: "", schemas: [], tables: [], relations: [], truncated: false, error: "Access to this database is not allowed" });
    }

    const schema = await loadDiagramSchema(pool, new URL(request.url).searchParams.get("schema"));
    const data: LoaderData = { database, ...schema };
    return Response.json(data, { headers: { "Cache-Control": "no-store" } });
};

// Card geometry, the SVG is drawn in these units and scaled by the zoom
const HEADER_H = 34;
const ROW_H = 24;
const PAD_BOTTOM = 6;
const CHAR_W = 7.2;
const COLORS = ["#8b5cf6", "#f59e0b", "#22c55e", "#ef4444", "#3b82f6", "#ec4899", "#14b8a6", "#f97316", "#6366f1", "#84cc16"];

interface Box {
    x: number;
    y: number;
    width: number;
    height: number;
}

const visibleColumns = (table: DiagramTable) => table.columns.slice(0, MAX_COLUMNS);

const tableSize = (table: DiagramTable) => {
    const columns = visibleColumns(table);
    const nameWidth = Math.max(...columns.map((column) => column.name.length), 4) * CHAR_W;
    const typeWidth = Math.max(...columns.map((column) => Math.min(column.type.length, 28)), 4) * 6.4;
    const width = Math.min(460, Math.max(220, table.name.length * 8.5 + 70, 46 + nameWidth + 24 + typeWidth + 14));
    const rows = columns.length + (table.columns.length > MAX_COLUMNS ? 1 : 0);
    return { width: Math.round(width), height: HEADER_H + rows * ROW_H + PAD_BOTTOM };
};

/**
 * Related tables are laid out by dagre, tables without relations go in a grid below them
 */
const autoLayout = (tables: DiagramTable[], relations: DiagramRelation[]) => {
    const connected = new Set<string>();
    for (const relation of relations) {
        if (relation.table !== relation.refTable) {
            connected.add(relation.table);
            connected.add(relation.refTable);
        }
    }
    const positions: Record<string, { x: number; y: number }> = {};
    let bottom = 0;
    let right = 0;

    if (connected.size) {
        const graph = new Graph({ multigraph: true });
        graph.setGraph({ rankdir: "LR", nodesep: 40, ranksep: 110, marginx: 40, marginy: 40 });
        graph.setDefaultEdgeLabel(() => ({}));
        for (const table of tables) if (connected.has(table.name)) graph.setNode(table.name, tableSize(table));
        for (const relation of relations) {
            if (relation.table !== relation.refTable) graph.setEdge(relation.refTable, relation.table, {}, relation.name);
        }
        dagreLayout(graph);
        for (const table of tables) {
            if (!connected.has(table.name)) continue;
            const node = graph.node(table.name) as any;
            positions[table.name] = { x: Math.round(node.x - node.width / 2), y: Math.round(node.y - node.height / 2) };
            bottom = Math.max(bottom, node.y + node.height / 2);
            right = Math.max(right, node.x + node.width / 2);
        }
    }

    const isolated = tables.filter((table) => !connected.has(table.name));
    if (isolated.length) {
        const columns = Math.max(1, Math.ceil(Math.sqrt(isolated.length * 1.6)));
        let x = 40;
        let y = connected.size ? bottom + 100 : 40;
        let rowHeight = 0;
        isolated.forEach((table, i) => {
            if (i > 0 && i % columns === 0) {
                x = 40;
                y += rowHeight + 40;
                rowHeight = 0;
            }
            const size = tableSize(table);
            positions[table.name] = { x, y };
            x += size.width + 40;
            rowHeight = Math.max(rowHeight, size.height);
        });
    }
    return positions;
};

const rowY = (table: DiagramTable, column: string) => {
    const index = visibleColumns(table).findIndex((c) => c.name === column);
    return HEADER_H + (index === -1 ? 0 : index) * ROW_H + ROW_H / 2;
};

/**
 * Orthogonal line from the foreign key column of the child to the key column of the parent
 */
const relationPath = (child: Box, childY: number, parent: Box, parentY: number, selfReference: boolean) => {
    if (selfReference) {
        const x = child.x + child.width;
        return { d: `M ${x} ${childY} H ${x + 30} V ${parentY} H ${x}`, start: { x, y: childY, dir: 1 }, end: { x, y: parentY, dir: 1 }, label: { x: x + 30, y: (childY + parentY) / 2 } };
    }
    const childRight = child.x + child.width;
    const parentRight = parent.x + parent.width;
    let startX: number, endX: number, startDir: number, endDir: number;
    if (childRight + 40 < parent.x) {
        [startX, startDir, endX, endDir] = [childRight, 1, parent.x, -1];
    } else if (parentRight + 40 < child.x) {
        [startX, startDir, endX, endDir] = [child.x, -1, parentRight, 1];
    } else {
        // Overlapping horizontally, go around on the right
        [startX, startDir, endX, endDir] = [childRight, 1, parentRight, 1];
    }
    const midX = startDir === endDir ? Math.max(startX, endX) + 30 : (startX + endX) / 2;
    return {
        d: `M ${startX} ${childY} H ${midX} V ${parentY} H ${endX}`,
        start: { x: startX, y: childY, dir: startDir },
        end: { x: endX, y: parentY, dir: endDir },
        label: { x: midX, y: (childY + parentY) / 2 },
    };
};

// "One" is two bars across the line, "many" is a crow's foot, both drawn pointing into the card
const oneMarker = (x: number, y: number, dir: number) => `M ${x + dir * 6} ${y - 6} V ${y + 6} M ${x + dir * 10} ${y - 6} V ${y + 6}`;
const manyMarker = (x: number, y: number, dir: number) => `M ${x + dir * 12} ${y} L ${x} ${y - 6} M ${x + dir * 12} ${y} L ${x} ${y + 6} M ${x + dir * 12} ${y - 6} V ${y + 6}`;

export default function DiagramPage() {
    const data = useLoaderData<LoaderData>();
    const navigate = useNavigate();
    const [searchParams, setSearchParams] = useSearchParams();
    const focus = searchParams.get("focus");
    const storageKey = `erd:${data.database}:${data.schema}`;

    const tablesByName = useMemo(() => new Map(data.tables.map((table) => [table.name, table])), [data.tables]);
    const colors = useMemo(() => new Map(data.tables.map((table, i) => [table.name, COLORS[i % COLORS.length]])), [data.tables]);
    const foreignKeyColumns = useMemo(() => {
        const set = new Set<string>();
        for (const relation of data.relations) for (const column of relation.columns) set.add(`${relation.table}.${column}`);
        return set;
    }, [data.relations]);

    const [positions, setPositions] = useState<Record<string, { x: number; y: number }>>({});
    // Relations that aren't declared as foreign keys, from column names and optionally AI
    const [inferred, setInferred] = useState<InferredRelation[]>([]);
    const [showInferred, setShowInferred] = useState(true);
    const [inferStatus, setInferStatus] = useState<{ loading?: boolean; ai?: boolean; error?: string; copied?: boolean }>({});
    const aiKey = `erd-ai:${data.database}:${data.schema}`;
    const visibleRelations = useMemo(() => (showInferred ? [...data.relations, ...inferred] : data.relations), [showInferred, data.relations, inferred]);
    const inferredColumns = useMemo(() => new Set(showInferred ? inferred.map((relation) => `${relation.table}.${relation.columns[0]}`) : []), [inferred, showInferred]);
    const [view, setView] = useState({ x: 0, y: 0, zoom: 1 });
    const [hovered, setHovered] = useState<string | null>(focus);
    const containerRef = useRef<HTMLDivElement>(null);
    const svgRef = useRef<SVGSVGElement>(null);
    // Until the user pans or zooms, the diagram keeps fitting its area, e.g. when side panels open or close
    const userMovedRef = useRef(false);
    const dragRef = useRef<{ kind: "pan" | "table"; table?: string; startX: number; startY: number; origin: { x: number; y: number }; moved: boolean } | null>(null);

    const bounds = useCallback(
        (pos: Record<string, { x: number; y: number }>) => {
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            for (const table of data.tables) {
                const p = pos[table.name];
                if (!p) continue;
                const size = tableSize(table);
                minX = Math.min(minX, p.x);
                minY = Math.min(minY, p.y);
                maxX = Math.max(maxX, p.x + size.width + 40);
                maxY = Math.max(maxY, p.y + size.height);
            }
            return minX === Infinity ? { x: 0, y: 0, width: 0, height: 0 } : { x: minX - 20, y: minY - 20, width: maxX - minX + 40, height: maxY - minY + 40 };
        },
        [data.tables]
    );

    const fit = useCallback(
        (pos = positions, target?: string | null) => {
            const container = containerRef.current;
            if (!container) return;
            const { width, height } = container.getBoundingClientRect();
            if (target && pos[target] && tablesByName.get(target)) {
                const size = tableSize(tablesByName.get(target)!);
                setView({ zoom: 1, x: width / 2 - (pos[target].x + size.width / 2), y: height / 2 - (pos[target].y + size.height / 2) });
                return;
            }
            const box = bounds(pos);
            if (!box.width) return;
            const zoom = Math.min(1.25, Math.max(0.15, Math.min(width / box.width, height / box.height)));
            setView({ zoom, x: (width - box.width * zoom) / 2 - box.x * zoom, y: (height - box.height * zoom) / 2 - box.y * zoom });
        },
        [positions, bounds, tablesByName]
    );

    // Saved positions for this database and schema, new tables are placed by the auto layout
    useEffect(() => {
        const computed = autoLayout(data.tables, visibleRelations);
        let saved: Record<string, { x: number; y: number }> = {};
        try {
            saved = JSON.parse(localStorage.getItem(storageKey) || "{}");
        } catch {
            // positions are only a convenience
        }
        const next = Object.fromEntries(data.tables.map((table) => [table.name, saved[table.name] || computed[table.name]]));
        setPositions(next);
        requestAnimationFrame(() => fit(next, focus));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [data.tables, visibleRelations, storageKey]);

    const mergeInferred = (relations: InferredRelation[]) =>
        setInferred((prev) => {
            const seen = new Set(prev.map((relation) => `${relation.table}.${relation.columns[0]}`));
            return [...prev, ...relations.filter((relation) => !seen.has(`${relation.table}.${relation.columns[0]}`))];
        });

    const requestInferred = async (intent: "infer" | "ai") => {
        setInferStatus((prev) => ({ ...prev, error: undefined, [intent === "ai" ? "ai" : "loading"]: true }));
        try {
            const response = await fetch("/api/diagram", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ db: data.database, schema: data.schema, intent }),
            });
            const result = await response.json();
            if (!response.ok) throw new Error(result.message || "Could not find relations");
            mergeInferred(result.relations);
            if (intent === "ai") {
                try {
                    localStorage.setItem(aiKey, JSON.stringify(result.relations));
                } catch {
                    // ignore
                }
                if (!result.relations.length) setInferStatus((prev) => ({ ...prev, error: "The AI found no additional relations" }));
            }
        } catch (e: any) {
            setInferStatus((prev) => ({ ...prev, error: e.message }));
        } finally {
            setInferStatus((prev) => ({ ...prev, [intent === "ai" ? "ai" : "loading"]: false }));
        }
    };

    // Name based guesses run on every visit, AI suggestions are remembered because they cost a request
    useEffect(() => {
        setInferred([]);
        if (!data.tables.length) return;
        try {
            const saved = JSON.parse(localStorage.getItem(aiKey) || "[]");
            if (Array.isArray(saved)) mergeInferred(saved);
        } catch {
            // ignore
        }
        requestInferred("infer");
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [data.database, data.schema]);

    const copyForeignKeySql = async () => {
        const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;
        const sql = inferred
            .filter((relation) => relation.confidence === "high" || relation.confidence === "medium")
            .map(
                (relation) =>
                    `ALTER TABLE ${quote(data.schema)}.${quote(relation.table)} ADD CONSTRAINT ${quote(`${relation.table}_${relation.columns[0]}_fkey`)} FOREIGN KEY (${quote(relation.columns[0])}) REFERENCES ${quote(data.schema)}.${quote(relation.refTable)} (${quote(relation.refColumns[0])});`
            )
            .join("\n");
        await navigator.clipboard.writeText(sql || "-- No inferred relations with enough matching data");
        setInferStatus((prev) => ({ ...prev, copied: true }));
        setTimeout(() => setInferStatus((prev) => ({ ...prev, copied: false })), 2000);
    };

    const savePositions = (next: Record<string, { x: number; y: number }>) => {
        try {
            localStorage.setItem(storageKey, JSON.stringify(next));
        } catch {
            // ignore
        }
    };

    const relayout = () => {
        userMovedRef.current = false;
        const next = autoLayout(data.tables, visibleRelations);
        setPositions(next);
        try {
            localStorage.removeItem(storageKey);
        } catch {
            // ignore
        }
        requestAnimationFrame(() => fit(next));
    };

    useEffect(() => {
        const container = containerRef.current;
        if (!container || typeof ResizeObserver === "undefined") return;
        const observer = new ResizeObserver(() => {
            if (!userMovedRef.current && Object.keys(positions).length) fit(positions, focus);
        });
        observer.observe(container);
        return () => observer.disconnect();
    }, [fit, positions, focus]);

    const zoomAt = (factor: number, clientX?: number, clientY?: number) => {
        userMovedRef.current = true;
        const rect = containerRef.current?.getBoundingClientRect();
        if (!rect) return;
        const px = (clientX ?? rect.left + rect.width / 2) - rect.left;
        const py = (clientY ?? rect.top + rect.height / 2) - rect.top;
        setView((v) => {
            const zoom = Math.min(2.5, Math.max(0.1, v.zoom * factor));
            const ratio = zoom / v.zoom;
            return { zoom, x: px - (px - v.x) * ratio, y: py - (py - v.y) * ratio };
        });
    };

    // Pinch or ctrl/cmd + wheel zooms, plain wheel pans
    useEffect(() => {
        const container = containerRef.current;
        if (!container) return;
        const onWheel = (event: WheelEvent) => {
            event.preventDefault();
            if (event.ctrlKey || event.metaKey) {
                zoomAt(Math.exp(-event.deltaY * 0.01), event.clientX, event.clientY);
            } else {
                userMovedRef.current = true;
                setView((v) => ({ ...v, x: v.x - event.deltaX, y: v.y - event.deltaY }));
            }
        };
        container.addEventListener("wheel", onWheel, { passive: false });
        return () => container.removeEventListener("wheel", onWheel);
    }, []);

    const onPointerDown = (event: React.PointerEvent, table?: string) => {
        if (event.button !== 0) return;
        event.stopPropagation();
        (event.currentTarget as Element).setPointerCapture?.(event.pointerId);
        dragRef.current = table
            ? { kind: "table", table, startX: event.clientX, startY: event.clientY, origin: positions[table], moved: false }
            : { kind: "pan", startX: event.clientX, startY: event.clientY, origin: { x: view.x, y: view.y }, moved: false };
    };

    const onPointerMove = (event: React.PointerEvent) => {
        const drag = dragRef.current;
        if (!drag) return;
        const dx = event.clientX - drag.startX;
        const dy = event.clientY - drag.startY;
        if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
        if (drag.kind === "pan") {
            if (drag.moved) userMovedRef.current = true;
            setView((v) => ({ ...v, x: drag.origin.x + dx, y: drag.origin.y + dy }));
        } else if (drag.table) {
            setPositions((prev) => ({ ...prev, [drag.table!]: { x: Math.round(drag.origin.x + dx / view.zoom), y: Math.round(drag.origin.y + dy / view.zoom) } }));
        }
    };

    const onPointerUp = () => {
        const drag = dragRef.current;
        dragRef.current = null;
        if (drag?.kind === "table" && drag.moved) savePositions(positions);
    };

    const openTable = (table: string) => {
        // Table pages work on the current schema
        if (data.schema === (data.current || "public")) navigate(`/database/${encodeURIComponent(data.database)}/${encodeURIComponent(table)}`);
    };

    const exportDiagram = async (format: "svg" | "png") => {
        const svg = svgRef.current;
        if (!svg) return;
        const box = bounds(positions);
        const clone = svg.cloneNode(true) as SVGSVGElement;
        clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
        clone.setAttribute("viewBox", `${box.x} ${box.y} ${box.width} ${box.height}`);
        clone.setAttribute("width", String(box.width));
        clone.setAttribute("height", String(box.height));
        clone.querySelector("g[data-viewport]")?.removeAttribute("transform");
        const background = document.createElementNS("http://www.w3.org/2000/svg", "rect");
        Object.entries({ x: box.x, y: box.y, width: box.width, height: box.height, fill: "rgb(var(--c-erd-bg))" }).forEach(([k, v]) => background.setAttribute(k, String(v)));
        clone.insertBefore(background, clone.firstChild);
        // Exports don't have the page's theme variables, write the current colors in
        const rootStyle = getComputedStyle(document.documentElement);
        const markup = new XMLSerializer()
            .serializeToString(clone)
            .replace(/rgb\(var\((--[a-z0-9-]+)\)\)/g, (_, name) => `rgb(${rootStyle.getPropertyValue(name).trim().split(/\s+/).join(",")})`);
        const fileName = `${data.database}-${data.schema}-diagram`;
        const download = (href: string, name: string) => {
            const a = document.createElement("a");
            a.href = href;
            a.download = name;
            a.click();
        };

        if (format === "svg") {
            const url = URL.createObjectURL(new Blob([markup], { type: "image/svg+xml" }));
            download(url, `${fileName}.svg`);
            setTimeout(() => URL.revokeObjectURL(url), 1000);
            return;
        }
        const image = new Image();
        image.onload = () => {
            const scale = 2;
            const canvas = document.createElement("canvas");
            canvas.width = box.width * scale;
            canvas.height = box.height * scale;
            const context = canvas.getContext("2d")!;
            context.scale(scale, scale);
            context.drawImage(image, 0, 0);
            download(canvas.toDataURL("image/png"), `${fileName}.png`);
        };
        image.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(markup);
    };

    const related = useMemo(() => {
        if (!hovered) return null;
        const set = new Set([hovered]);
        for (const relation of visibleRelations) {
            if (relation.table === hovered) set.add(relation.refTable);
            if (relation.refTable === hovered) set.add(relation.table);
        }
        return set;
    }, [hovered, visibleRelations]);

    const ready = Object.keys(positions).length === data.tables.length;

    return (
        <div className="flex flex-col h-[calc(100vh-7rem)]">
            <DatabaseTabs database={data.database} active="relations" />
            <div className="flex flex-wrap items-center justify-between gap-3 pb-3">
                <div className="min-w-0">
                    <div className="text-xs text-neutral-500">
                        {data.tables.length} tables · {data.relations.length} declared relations
                        {inferred.length > 0 && ` · ${inferred.length} inferred`}
                        {inferStatus.loading && " · looking for undeclared relations…"}
                        {data.truncated ? ` · showing the first ${MAX_TABLES} tables` : ""}
                    </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                    {data.schemas.length > 1 && (
                        <Select value={data.schema} onValueChange={(schema) => setSearchParams({ schema })}>
                            <SelectTrigger className="h-8 text-xs bg-white w-44">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                {data.schemas.map((schema) => (
                                    <SelectItem key={schema.name} value={schema.name}>
                                        {schema.name} <span className="text-neutral-400">({schema.tables})</span>
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    )}
                    <div className="flex items-center border border-neutral-200 bg-white">
                        <Button size="xs" variant="ghost" hasIconOnly icon={<ZoomOutIcon />} tooltip="Zoom out" onClick={() => zoomAt(1 / 1.2)} />
                        <span className="w-12 text-xs text-center tabular-nums">{Math.round(view.zoom * 100)}%</span>
                        <Button size="xs" variant="ghost" hasIconOnly icon={<ZoomInIcon />} tooltip="Zoom in" onClick={() => zoomAt(1.2)} />
                        <Button size="xs" variant="ghost" hasIconOnly icon={<ScreenFullIcon />} tooltip="Fit to screen" onClick={() => { userMovedRef.current = false; fit(); }} />
                    </div>
                    <label className="flex items-center gap-1.5 px-2 text-xs border h-8 bg-white border-neutral-200" title="Relations that aren't declared as foreign keys, found from column names or AI and checked against the data">
                        <input type="checkbox" checked={showInferred} onChange={(e) => setShowInferred(e.target.checked)} /> Inferred
                    </label>
                    <Button size="xs" variant="outline" icon={<Sparkles size={14} />} loading={inferStatus.ai} disabled={inferStatus.ai} onClick={() => requestInferred("ai")} tooltip="Suggest relations with AI, only table and column definitions are sent">
                        Ask AI
                    </Button>
                    {inferred.length > 0 && (
                        <Button size="xs" variant="outline" icon={<CopyIcon />} onClick={copyForeignKeySql} tooltip="Copy ALTER TABLE statements that add the inferred relations as foreign keys">
                            {inferStatus.copied ? "Copied" : "Copy SQL"}
                        </Button>
                    )}
                    <Button size="xs" variant="outline" icon={<LayoutGrid size={14} />} onClick={relayout}>
                        Auto layout
                    </Button>
                    <Button size="xs" variant="outline" icon={<DownloadIcon />} onClick={() => exportDiagram("png")}>
                        PNG
                    </Button>
                    <Button size="xs" variant="outline" icon={<DownloadIcon />} onClick={() => exportDiagram("svg")}>
                        SVG
                    </Button>
                </div>
            </div>

            {inferStatus.error && <div className="px-3 py-1.5 mb-2 text-xs text-amber-800 border border-amber-200 bg-amber-50">{inferStatus.error}</div>}
            {data.error ? (
                <div className="p-4 text-sm text-red-700 border border-red-200 bg-red-50">{data.error}</div>
            ) : data.tables.length === 0 ? (
                <div className="p-4 text-sm border text-neutral-600 border-neutral-200 bg-neutral-50">This schema has no tables.</div>
            ) : (
                <div
                    ref={containerRef}
                    className="relative flex-1 overflow-hidden border select-none border-neutral-200 cursor-grab active:cursor-grabbing"
                    style={{ backgroundColor: "rgb(var(--c-erd-bg))", backgroundImage: "radial-gradient(rgb(var(--c-erd-border)) 1px, transparent 1px)", backgroundSize: `${20 * view.zoom}px ${20 * view.zoom}px`, backgroundPosition: `${view.x}px ${view.y}px` }}
                    onPointerDown={(e) => onPointerDown(e)}
                    onPointerMove={onPointerMove}
                    onPointerUp={onPointerUp}>
                    <svg ref={svgRef} className="absolute inset-0 w-full h-full" style={{ fontFamily: "'Geist Mono', ui-monospace, monospace" }}>
                        <g data-viewport transform={`translate(${view.x} ${view.y}) scale(${view.zoom})`}>
                            {ready &&
                                visibleRelations.map((relation) => {
                                    const guess = "source" in relation ? (relation as InferredRelation) : null;
                                    const child = tablesByName.get(relation.table)!;
                                    const parent = tablesByName.get(relation.refTable)!;
                                    const childBox = { ...positions[relation.table], ...tableSize(child) };
                                    const parentBox = { ...positions[relation.refTable], ...tableSize(parent) };
                                    const path = relationPath(
                                        childBox,
                                        childBox.y + rowY(child, relation.columns[0]),
                                        parentBox,
                                        parentBox.y + rowY(parent, relation.refColumns[0]),
                                        relation.table === relation.refTable
                                    );
                                    const oneToOne = child.unique.some((columns) => columns.length === relation.columns.length && columns.every((c) => relation.columns.includes(c)));
                                    const color = colors.get(relation.refTable)!;
                                    const dimmed = related && !(relation.table === hovered || relation.refTable === hovered);
                                    const label = guess ? (guess.sampled ? `${Math.round(((guess.matched || 0) / guess.sampled) * 100)}%` : guess.source === "ai" ? "AI" : "?") : oneToOne ? "1:1" : "1:N";
                                    return (
                                        <g key={`${relation.table}.${relation.name}`} opacity={dimmed ? 0.12 : guess ? 0.85 : 1} stroke={color} fill="none" strokeWidth={related && !dimmed ? 2.2 : 1.6}>
                                            <title>
                                                {`${relation.table}(${relation.columns.join(", ")}) → ${relation.refTable}(${relation.refColumns.join(", ")})`}
                                                {guess
                                                    ? `\nInferred${guess.source === "ai" ? " by AI" : " from the column name"}, not a declared foreign key\n${guess.reason}\n${
                                                          guess.sampled ? `${guess.matched} of ${guess.sampled} sampled values exist in ${relation.refTable}` : "Not checked against the data"
                                                      }`
                                                    : ""}
                                            </title>
                                            <path d={path.d} strokeLinejoin="round" strokeDasharray={guess ? "6 4" : undefined} />
                                            <path d={oneToOne ? oneMarker(path.start.x, path.start.y, path.start.dir) : manyMarker(path.start.x, path.start.y, path.start.dir)} />
                                            <path d={oneMarker(path.end.x, path.end.y, path.end.dir)} />
                                            <g transform={`translate(${path.label.x} ${path.label.y})`}>
                                                <rect x={-17} y={-9} width={34} height={18} rx={3} fill="rgb(var(--c-erd-bg))" stroke={guess ? color : "none"} strokeDasharray={guess ? "2 2" : undefined} strokeWidth={1} />
                                                <text textAnchor="middle" dominantBaseline="central" fontSize={10} fill={color} stroke="none" fontWeight={600}>
                                                    {label}
                                                </text>
                                            </g>
                                        </g>
                                    );
                                })}

                            {ready &&
                                data.tables.map((table) => {
                                    const { x, y } = positions[table.name];
                                    const { width, height } = tableSize(table);
                                    const color = colors.get(table.name)!;
                                    const dimmed = related && !related.has(table.name);
                                    const highlighted = hovered === table.name;
                                    return (
                                        <g
                                            key={table.name}
                                            transform={`translate(${x} ${y})`}
                                            opacity={dimmed ? 0.35 : 1}
                                            onPointerEnter={() => setHovered(table.name)}
                                            onPointerLeave={() => setHovered(focus)}
                                            onPointerDown={(e) => onPointerDown(e, table.name)}
                                            onDoubleClick={() => openTable(table.name)}
                                            style={{ cursor: "move" }}>
                                            <title>{data.schema === (data.current || "public") ? "Drag to move, double click to open" : "Drag to move"}</title>
                                            <rect width={width} height={height} rx={6} fill="rgb(var(--c-erd-card))" stroke={highlighted ? color : "rgb(var(--c-erd-border))"} strokeWidth={highlighted ? 2 : 1} />
                                            <path d={`M 0 6 a 6 6 0 0 1 6 -6 H ${width - 6} a 6 6 0 0 1 6 6 V ${HEADER_H} H 0 Z`} fill={color} />
                                            <text x={12} y={HEADER_H / 2} dominantBaseline="central" fontSize={13} fontWeight={700} fill="#ffffff" fontFamily="system-ui, sans-serif">
                                                {table.name}
                                            </text>
                                            {table.estimatedRows != null && (
                                                <text x={width - 10} y={HEADER_H / 2} dominantBaseline="central" textAnchor="end" fontSize={10} fill="#ffffff" opacity={0.85}>
                                                    {table.estimatedRows.toLocaleString()} rows
                                                </text>
                                            )}
                                            {visibleColumns(table).map((column, i) => {
                                                const cy = HEADER_H + i * ROW_H + ROW_H / 2;
                                                const isPk = table.primaryKey.includes(column.name);
                                                const isFk = foreignKeyColumns.has(`${table.name}.${column.name}`);
                                                const isInferredFk = !isFk && inferredColumns.has(`${table.name}.${column.name}`);
                                                return (
                                                    <g key={column.name}>
                                                        {i > 0 && <line x1={8} x2={width - 8} y1={cy - ROW_H / 2} y2={cy - ROW_H / 2} stroke="rgb(var(--c-erd-row))" />}
                                                        {isPk ? (
                                                            <g transform={`translate(10 ${cy - 7})`}>
                                                                <rect width={22} height={14} rx={3} fill="rgb(var(--c-green-100))" />
                                                                <text x={11} y={7} textAnchor="middle" dominantBaseline="central" fontSize={8} fontWeight={700} fill="rgb(var(--c-green-700))">
                                                                    PK
                                                                </text>
                                                            </g>
                                                        ) : isFk ? (
                                                            <g transform={`translate(10 ${cy - 7})`}>
                                                                <rect width={22} height={14} rx={3} fill="rgb(var(--c-blue-100))" />
                                                                <text x={11} y={7} textAnchor="middle" dominantBaseline="central" fontSize={8} fontWeight={700} fill="rgb(var(--c-blue-700))">
                                                                    FK
                                                                </text>
                                                            </g>
                                                        ) : isInferredFk ? (
                                                            <g transform={`translate(10 ${cy - 7})`}>
                                                                <rect width={22} height={14} rx={3} fill="rgb(var(--c-erd-card))" stroke="rgb(var(--c-blue-300))" strokeDasharray="2 2" />
                                                                <text x={11} y={7} textAnchor="middle" dominantBaseline="central" fontSize={8} fontWeight={700} fill="rgb(var(--c-blue-500))">
                                                                    FK
                                                                </text>
                                                            </g>
                                                        ) : null}
                                                        <text x={40} y={cy} dominantBaseline="central" fontSize={12} fill="rgb(var(--c-erd-text))" fontWeight={column.notNull ? 600 : 400}>
                                                            {column.name}
                                                        </text>
                                                        <text x={width - 10} y={cy} dominantBaseline="central" textAnchor="end" fontSize={10} fill="rgb(var(--c-erd-muted))">
                                                            {column.type.length > 28 ? column.type.slice(0, 27) + "…" : column.type.toUpperCase()}
                                                        </text>
                                                    </g>
                                                );
                                            })}
                                            {table.columns.length > MAX_COLUMNS && (
                                                <text x={12} y={HEADER_H + MAX_COLUMNS * ROW_H + ROW_H / 2} dominantBaseline="central" fontSize={11} fill="rgb(var(--c-erd-muted))">
                                                    +{table.columns.length - MAX_COLUMNS} more columns
                                                </text>
                                            )}
                                        </g>
                                    );
                                })}
                        </g>
                    </svg>

                    <div className="absolute flex items-center gap-4 px-3 py-1.5 text-xs bg-white border bottom-3 right-3 border-neutral-200 text-neutral-600" onPointerDown={(e) => e.stopPropagation()}>
                        <span className="flex items-center gap-1.5">
                            <svg width="26" height="12" stroke="currentColor" fill="none" strokeWidth="1.5">
                                <path d="M 0 6 H 26 M 18 0 V 12 M 22 0 V 12" />
                            </svg>
                            One
                        </span>
                        <span className="flex items-center gap-1.5">
                            <svg width="26" height="12" stroke="currentColor" fill="none" strokeWidth="1.5">
                                <path d="M 0 6 H 26 M 14 6 L 26 0 M 14 6 L 26 12 M 14 0 V 12" />
                            </svg>
                            Many
                        </span>
                        <span className="flex items-center gap-1.5">
                            <svg width="26" height="12" stroke="currentColor" fill="none" strokeWidth="1.5">
                                <path d="M 0 6 H 26" strokeDasharray="4 3" />
                            </svg>
                            Inferred (% of values found)
                        </span>
                        <span className="text-neutral-400">Bold = NOT NULL · scroll to pan, ⌘/ctrl + scroll to zoom</span>
                    </div>
                </div>
            )}
        </div>
    );
}
