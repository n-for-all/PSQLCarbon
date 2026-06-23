import { ArrowRightIcon, ListUnorderedIcon, ServerIcon, TrashIcon, SyncIcon } from "@primer/octicons-react";
import { ActionFunction, LoaderFunction, redirect } from "@remix-run/node";
import { useFetcher, useLoaderData, useNavigate, useParams } from "@remix-run/react";
import { useState, SyntheticEvent, useEffect, useRef } from "react";
import config from "~/config";
import { Collection } from "~/lib/data/collection";
import db, { ConnectionData } from "~/lib/db";
import { numberWithCommas } from "~/utils/functions";

import Title from "~/components/title";
import { JsonTreeEditor } from "~/components/tree";
import { CsvTable } from "~/components/csv_table";
import { Editor } from "@monaco-editor/react";
import { AlertMessage } from "~/components/alert";

import { getUserSession } from "~/utils/session.server";
import { CollectionDeleteModal } from "~/components/collection";
import { Button } from "~/ui/button";
import { Accordion, AccordionItem, AccordionContent, AccordionTrigger } from "~/ui/accordion";
import { Table, TableBody, TableCell, TableRow } from "~/ui/table";
import { Pagination } from "~/ui/pagination";
import { Select, SelectTrigger, SelectContent, SelectItem, SelectValue } from "~/ui/select";
import { Alert, AlertTitle, AlertDescription } from "~/ui/alert";
import { SearchInput } from "~/ui/input";

import { toast } from "~/ui/hooks/use-toast";
import { ChartNoAxesColumn } from "lucide-react";

type loaderCollectionData = {
    title: string;
    stats:
        | {
              count: number;
              size: number;
              storageSize: number;
              totalIndexSize: number;
              ns: string;
              host: string;
              localTime: string;
              latencyStats: {
                  reads: {
                      latency: string;
                  };
                  writes: {
                      latency: string;
                  };
                  commands: {
                      latency: string;
                  };
                  transactions: {
                      latency: string;
                  };
                  storageStats: {
                      latency: string;
                  };
              };
              storageStats: {
                  storageSize: number;
                  totalIndexSize: number;
                  totalSize: number;
                  count: number;
              };
              queryExecStats: {
                  collectionScans: {
                      total: number;
                      nonTailable: number;
                  };
              };
          }
        | null
        | any;
    count: number;
    documents: string;
    raw?: any;
    params: { db: string; col: string };
    columns?: any;
    skip?: number;
    limit?: number;
    sort?: { [key: string]: string | number };
    indexes?: Array<{name: string, definition: string}>;
    structure?: Array<{name: string, type: string, max_length: number, is_nullable: string, default_value: string}>;
};



export const IdeWithAutocomplete = ({ onChange, value }) => {
    const [mounted, setMounted] = useState(false);
    useEffect(() => setMounted(true), []);

    if (!mounted) {
        return <div className="min-h-[150px] border border-neutral-200 p-4 text-xs text-neutral-500">Loading editor...</div>;
    }

    return (
        <Editor
            height="150px"
            language="pgsql"
            theme="light"
            value={value}
            onChange={onChange}
            options={{
                fontSize: 14,
                fontFamily: "'Geist Mono', monospace",
                minimap: { enabled: false },
                padding: { top: 10 },
            }}
        />
    );
};

const loadConnection = async (request: Request): Promise<ConnectionData> => {
    const session = await getUserSession(request);
    const connection = session.get("connection");
    if (!connection) {
        throw redirect("/connections");
    }

    return await db(connection);
};

const loadCollectionData = async ({ jsonQuery, request, params, withColumns = false }): Promise<loaderCollectionData> => {
    const url = new URL(request.url);
    const query = url.searchParams;
    if (!params.db) {
        throw new Error("No database specified");
    }
    if (!params.col) {
        throw new Error("No collection specified");
    }

    let sortKey = query.get("sort") || jsonQuery.sort || "";
    const pagination = {
        limit: query.get("limit") || jsonQuery.limit || 10,
        skip: query.get("skip") || jsonQuery.skip || 0,
    };

    if (sortKey != "") {
        pagination["sort"] = {};
        pagination["sort"][sortKey] = query.get("direction") || jsonQuery.direction || 0;
    }

    const mongo = await loadConnection(request);
    const collection = new Collection(mongo, params.db, params.col, config);
    const collectionData = await collection.viewCollection({ ...jsonQuery, ...pagination });
    if (withColumns) {
        let columns: any = {};
        let parsedColumns = await collection.getColumns();
        parsedColumns.forEach((col) => {
            columns[col] = "";
        });
        return { ...collectionData, documents: JSON.stringify(collectionData.docs), params, ...pagination, columns };
    }
    return { ...collectionData, documents: JSON.stringify(collectionData.docs), params, ...pagination };
};

export const action: ActionFunction = async ({ request, params }) => {
    try {
        const jsonQuery = await request.json();
        if (!jsonQuery) {
            return Response.json({ status: "error", message: "No query specified" }, { status: 500 });
        }

        if (jsonQuery.sql) {
            const mongo = await loadConnection(request);
            const pool = mongo.getPool(params.db);
            if (!pool) {
                return Response.json({ status: "error", message: "No database connection" }, { status: 500 });
            }

            try {
                const res = await pool.query(jsonQuery.sql);
                // Return columns and rows for raw view
                const raw = {
                    columns: res.fields ? res.fields.map(f => f.name) : [],
                    rows: res.rows
                };
                return Response.json({ status: "success", raw }, { status: 200 });
            } catch (e: any) {
                return Response.json({ status: "error", message: e.message }, { status: 500 });
            }
        }

        // Standard pagination/sorting
        const output = await loadCollectionData({
            jsonQuery,
            request,
            params,
            withColumns: false,
        });

        return Response.json({ status: "success", raw: null, ...output }, { status: 200 });
    } catch (e: any) {
        return Response.json({ status: "error", message: e.message }, { status: 500 });
    }
};
export const loader: LoaderFunction = async ({ request, params }) => {
    try {
        const data = await loadCollectionData({ jsonQuery: {}, request, params, withColumns: true });
        return Response.json(
            { ...data },
            {
                headers: {
                    "Cache-Control": "no-store",
                },
            }
        );
    } catch (e: any) {
        if (e instanceof Response) {
            return e;
        }
        return Response.json({ status: "error", message: e.message }, { status: 500 });
    }
};

export default function CollectionPage() {
    const loaderData = useLoaderData<typeof loader>();
    const [currentPage, setCurrentPage] = useState({
        page: 1,
        pageSize: 10,
    });
    const [sort, setSort] = useState({
        field: "",
        direction: 0,
    });

    const fetcher = useFetcher<
        {
            status: string;
            message?: string;
        } & loaderCollectionData
    >();

    const pageFetcher = useFetcher<
        {
            status: string;
            message?: string;
        } & loaderCollectionData
    >();

    const initRef = useRef(false);

    const [view, setView] = useState("grid");
    const [jsonQuery, setJsonQuery] = useState({});
    const [jsonQueryString, setJsonQueryString] = useState("");
    const [errorJsonQueryString, setErrorJsonQueryString] = useState("");
    const [isDelete, setIsDelete] = useState(false);
    const [searchField, setSearchField] = useState("");
    const [searchValue, setSearchValue] = useState("");
    const navigate = useNavigate();

    const { columns } = loaderData;
    const [data, setData] = useState<loaderCollectionData>(loaderData);
    const { title, stats, count, documents: loaderDocuments, raw, indexes, structure } = data;
    const routeParams = useParams();

    let documents = [];
    try {
        if (loaderDocuments && loaderDocuments !== "undefined") {
            documents = JSON.parse(loaderDocuments);
        }
    } catch (e) {}
    const loading = fetcher.state == "submitting" || fetcher.state == "loading";

    useEffect(() => {
        const handler = (e: any) => {
            const sql = e.detail?.sql;
            if (sql) {
                setJsonQueryString(sql);
                setErrorJsonQueryString("");
            }
        };
        window.addEventListener("ai-populate-editor", handler);
        return () => window.removeEventListener("ai-populate-editor", handler);
    }, []);

    const executeSql = () => {
        if (!jsonQueryString || jsonQueryString.trim() === "") {
            setErrorJsonQueryString("Please enter a SQL query");
            return;
        }

        setErrorJsonQueryString("");
        fetcher.submit(
            {
                sql: jsonQueryString,
            },
            {
                method: "POST",
                encType: "application/json",
                action: `/database/${routeParams.db}/${routeParams.col}`,
            }
        );
    };

    const refreshData = (pageOverride?: number) => {
        const pageToUse = pageOverride || currentPage.page;
        const paginationObj: any = {};
        if (pageToUse > 1) {
            const skip = (pageToUse - 1) * currentPage.pageSize;
            paginationObj["skip"] = skip;
        }

        if (currentPage.pageSize != 10) {
            paginationObj["limit"] = currentPage.pageSize;
        }

        const payload: any = {
            ...paginationObj,
            sort: sort.field,
            direction: sort.direction,
        };

        if (searchField && searchValue) {
            payload.key = searchField;
            payload.value = searchValue;
            payload.type = "S";
        }

        pageFetcher.submit(
            payload,
            {
                method: "POST",
                encType: "application/json",
                action: `/database/${routeParams.db}/${routeParams.col}`,
            }
        );
    };

    useEffect(() => {
        if (!initRef.current) {
            initRef.current = true;
            return; // Skip effect on first render
        }

        if (!routeParams.db || !routeParams.col) {
            return;
        }

        refreshData();
    }, [currentPage.page, currentPage.pageSize, sort.field, sort.direction]);

    useEffect(() => {
        if (fetcher.data && fetcher.data.status == "success") {
            setData({
                ...data,
                ...fetcher.data,
            });
            setCurrentPage({
                ...currentPage,
                page: fetcher.data.skip ? Math.floor((fetcher.data.skip || 0) / (fetcher.data.limit || 10)) + 1 : 1,
                pageSize: fetcher.data.limit || 10,
            });

            toast({
                title: "Success",
                variant: "success",
                description: "Executed",
            });
        } else if (fetcher.data && fetcher.data.status == "error") {
            setErrorJsonQueryString(fetcher.data?.message || "");
        }
    }, [fetcher.data]);

    useEffect(() => {
        if (pageFetcher.data && pageFetcher.data.status == "success") {
            setData({
                ...data,
                ...pageFetcher.data,
            });
            setCurrentPage({
                ...currentPage,
                page: pageFetcher.data.skip ? Math.floor((pageFetcher.data.skip || 0) / (pageFetcher.data.limit || 10)) + 1 : 1,
                pageSize: pageFetcher.data.limit || 10,
            });
        } else if (pageFetcher.data && pageFetcher.data.status == "error") {
            setErrorJsonQueryString(pageFetcher.data?.message || "");
        }
    }, [pageFetcher.data]);



    const errorData = data as any;
    if (errorData?.status === "error" || errorData?.error) {
        return (
            <div className="p-4 bg-white border border-neutral-200 m-4 flex flex-col gap-4 items-start">
                <Alert variant="error">
                    <AlertTitle>Table Error</AlertTitle>
                    <AlertDescription>{errorData.message || errorData.error || "The table could not be found or has been deleted."}</AlertDescription>
                </Alert>
                <Button onClick={() => navigate(`/database/${routeParams.db}`)}>Go Back to Database</Button>
            </div>
        );
    }

    if (!stats) {
        return <div>Loading...</div>;
    }

    const isRaw = !!raw;
    const currentRows = isRaw ? raw.rows : documents;
    const currentColumns = isRaw ? raw.columns : (Array.isArray(data.columns) ? data.columns : Object.keys(data.columns || {}));

    let items: any = null;
    if (view == "grid") {
        items = (
            <CsvTable
                sort={sort}
                columns={currentColumns}
                onSort={(key) => {
                    setSort((prevSort) => ({
                        field: key,
                        direction: prevSort.field == key ? prevSort.direction * -1 : 1,
                    }));
                    if (!isRaw) setCurrentPage({ ...currentPage, page: 1 });
                }}
                rows={currentRows || []}
            />
        );
    } else {
        items = currentRows?.map((doc: any, index: number) => {
            return (
                <div key={doc._id ? doc._id.toString() : `document-${index}`} className="w-full p-4 mb-3 overflow-auto bg-white border border-solid border-neutral-300">
                    <JsonTreeEditor autocompleteItems={columns} isExpanded={false} data={doc} />
                </div>
            );
        });
    }

    return (
        <>
            <div className="database-page">
                <div className="flex items-center justify-between pb-4">
                    <div>
                        <Title title={title}>
                            <>
                                <span className="font-normal text-base opacity-50">Table:</span>
                                <span className="ml-1 font-mono text-base">{title}</span>
                            </>
                        </Title>
                        <p className="text-sm">{isRaw ? `Returned Rows: ${currentRows?.length || 0}` : `Total Rows: ${count || 0}`}</p>
                    </div>
                    <div className="flex items-center justify-end gap-1">
                        <Button
                            size="sm"
                            variant="danger"
                            icon={<TrashIcon />}
                            tooltip="Delete Table"
                            onClick={(e: SyntheticEvent) => {
                                e.preventDefault();
                                setIsDelete(true);
                            }}>
                            Delete Table
                        </Button>
                        <Button
                            hasIconOnly
                            size="md"
                            variant="ghost"
                            className={view == "list" ? "bg-neutral-100" : ""}
                            icon={<ListUnorderedIcon />}
                            tooltip="List View"
                            onClick={(e: SyntheticEvent) => {
                                e.preventDefault();
                                setView("list");
                            }}></Button>
                        <Button
                            hasIconOnly
                            size="md"
                            variant="ghost"
                            className={view == "grid" ? "bg-neutral-100" : ""}
                            icon={<ServerIcon />}
                            tooltip="Table View"
                            onClick={(e: SyntheticEvent) => {
                                e.preventDefault();
                                setView("grid");
                            }}></Button>
                    </div>
                </div>
                <div className="p-4 mt-1 mb-1 border border-solid border-neutral-300">
                    <div className="py-1">
                        <span className="block text-base font-bold">Query</span>
                        <span className="block mb-2 text-xs opacity-50">Please enter your query below</span>
                    </div>
                    <div className="flex flex-col bg-white border border-neutral-200 min-h-36">
                        <div className="flex-1 overflow-auto">
                            <IdeWithAutocomplete
                                value={jsonQueryString}
                                onChange={(data) => {
                                    setJsonQueryString(data);
                                }}
                            />
                        </div>
                    </div>
                    <div className="flex flex-col gap-2 mt-2">
                        <div className="flex items-center justify-between">
                            <Button
                                size="sm"
                                disabled={!jsonQueryString || jsonQueryString == ""}
                                icon={<ArrowRightIcon />}
                                loading={loading}
                                onClick={(e: SyntheticEvent) => {
                                    e.preventDefault();
                                    executeSql();
                                }}>
                                Execute SQL
                            </Button>
                        </div>
                        {errorJsonQueryString != "" && <AlertMessage message={errorJsonQueryString} onClose={() => setErrorJsonQueryString("")} />}
                    </div>
                </div>

                <div className="mb-3 bg-neutral-100">
                    <Accordion type="multiple">
                        <AccordionItem value="statistics" className="pr-0 ">
                            <AccordionTrigger className="px-4 border-t border-solid border-neutral-200">
                                <span className="flex items-center font-medium">
                                    <ChartNoAxesColumn className="w-4 h-4 mr-2" /> Statistics
                                </span>
                            </AccordionTrigger>

                            <AccordionContent className="px-0">
                                <div className="flex flex-col items-start w-full pb-4 lg:flex-row p-4">
                                    <div className="flex-1 w-full mr-4">
                                        <Table className="text-md">
                                            <TableBody>
                                                <TableRow>
                                                    <TableCell className="font-bold">Namespace (Table)</TableCell>
                                                    <TableCell>{stats.ns}</TableCell>
                                                </TableRow>
                                                <TableRow>
                                                    <TableCell className="font-bold">Local Time</TableCell>
                                                    <TableCell>{stats.localTime}</TableCell>
                                                </TableRow>
                                                <TableRow>
                                                    <TableCell className="font-bold">Storage Size</TableCell>
                                                    <TableCell>{numberWithCommas(stats.storageStats?.storageSize)} B</TableCell>
                                                </TableRow>
                                                <TableRow>
                                                    <TableCell className="font-bold">Total Index Size</TableCell>
                                                    <TableCell>{numberWithCommas(stats.storageStats?.totalIndexSize)} B</TableCell>
                                                </TableRow>
                                                <TableRow>
                                                    <TableCell className="font-bold">Total Size</TableCell>
                                                    <TableCell>{numberWithCommas(stats.storageStats?.totalSize)} B</TableCell>
                                                </TableRow>
                                            </TableBody>
                                        </Table>
                                    </div>
                                    <div className="flex-1 w-full">
                                        <Table className="mt-4 text-md lg:mt-0">
                                            <TableBody>
                                                <TableRow>
                                                    <TableCell className="font-bold">Live Tuples (Rows)</TableCell>
                                                    <TableCell>{numberWithCommas(stats.queryExecStats?.liveTuples)}</TableCell>
                                                </TableRow>
                                                <TableRow>
                                                    <TableCell className="font-bold">Tuples Inserted</TableCell>
                                                    <TableCell>{numberWithCommas(stats.queryExecStats?.inserted)}</TableCell>
                                                </TableRow>
                                                <TableRow>
                                                    <TableCell className="font-bold">Tuples Updated</TableCell>
                                                    <TableCell>{numberWithCommas(stats.queryExecStats?.updated)}</TableCell>
                                                </TableRow>
                                                <TableRow>
                                                    <TableCell className="font-bold">Tuples Deleted</TableCell>
                                                    <TableCell>{numberWithCommas(stats.queryExecStats?.deleted)}</TableCell>
                                                </TableRow>
                                                <TableRow>
                                                    <TableCell className="font-bold">Sequential Scans</TableCell>
                                                    <TableCell>{numberWithCommas(stats.queryExecStats?.seqScans)}</TableCell>
                                                </TableRow>
                                                <TableRow>
                                                    <TableCell className="font-bold">Index Scans</TableCell>
                                                    <TableCell>{numberWithCommas(stats.queryExecStats?.idxScans)}</TableCell>
                                                </TableRow>
                                            </TableBody>
                                        </Table>
                                    </div>
                                </div>
                            </AccordionContent>
                        </AccordionItem>
                        {structure && structure.length > 0 && (
                            <AccordionItem value="structure" className="pr-0 ">
                                <AccordionTrigger className="px-4 border-t border-solid border-neutral-200">
                                    <span className="flex items-center font-medium">
                                        <ListUnorderedIcon className="w-4 h-4 mr-2" /> Structure
                                    </span>
                                </AccordionTrigger>
                                <AccordionContent className="px-0">
                                    <div className="p-4 w-full overflow-x-auto">
                                        <Table className="text-md">
                                            <TableBody>
                                                <TableRow>
                                                    <TableCell className="font-bold">Name</TableCell>
                                                    <TableCell className="font-bold">Type</TableCell>
                                                    <TableCell className="font-bold">Max Length</TableCell>
                                                    <TableCell className="font-bold">Nullable</TableCell>
                                                    <TableCell className="font-bold">Default Value</TableCell>
                                                </TableRow>
                                                {structure.map((col, i) => (
                                                    <TableRow key={i}>
                                                        <TableCell>{col.name}</TableCell>
                                                        <TableCell>{col.type}</TableCell>
                                                        <TableCell>{col.max_length || "-"}</TableCell>
                                                        <TableCell>{col.is_nullable}</TableCell>
                                                        <TableCell>{col.default_value || "-"}</TableCell>
                                                    </TableRow>
                                                ))}
                                            </TableBody>
                                        </Table>
                                    </div>
                                </AccordionContent>
                            </AccordionItem>
                        )}
                        {indexes && indexes.length > 0 && (
                            <AccordionItem value="indexes" className="pr-0 ">
                                <AccordionTrigger className="px-4 border-t border-solid border-neutral-200">
                                    <span className="flex items-center font-medium">
                                        <ServerIcon className="w-4 h-4 mr-2" /> Indexes
                                    </span>
                                </AccordionTrigger>
                                <AccordionContent className="px-0">
                                    <div className="p-4 w-full overflow-x-auto">
                                        <Table className="text-md">
                                            <TableBody>
                                                <TableRow>
                                                    <TableCell className="font-bold">Name</TableCell>
                                                    <TableCell className="font-bold">Definition</TableCell>
                                                </TableRow>
                                                {indexes.map((idx, i) => (
                                                    <TableRow key={i}>
                                                        <TableCell>{idx.name}</TableCell>
                                                        <TableCell className="font-mono text-xs">{idx.definition}</TableCell>
                                                    </TableRow>
                                                ))}
                                            </TableBody>
                                        </Table>
                                    </div>
                                </AccordionContent>
                            </AccordionItem>
                        )}
                    </Accordion>
                </div>
                
                <div className="flex items-center gap-2 mb-3 bg-neutral-100 p-2 border border-neutral-200">
                    <Select value={searchField} onValueChange={setSearchField}>
                        <SelectTrigger className="w-[180px] h-8 bg-white text-xs font-semibold">
                            <SelectValue placeholder="Select Column" />
                        </SelectTrigger>
                        <SelectContent>
                            {currentColumns.map((col: string) => (
                                <SelectItem key={col} value={col}>{col}</SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                    <SearchInput
                        placeholder="Search exactly..." 
                        value={searchValue}
                        onChange={(value) => setSearchValue(value)}
                        onKeyDown={(e: React.KeyboardEvent) => {
                            if (e.key === "Enter") {
                                if (currentPage.page === 1) {
                                    refreshData();
                                } else {
                                    setCurrentPage({ ...currentPage, page: 1 });
                                }
                            }
                        }}
                        className="w-[250px] h-8 text-xs border-neutral-300"
                    />
                    <Button size="sm" variant="secondary" onClick={() => {
                        if (currentPage.page === 1) {
                            refreshData();
                        } else {
                            setCurrentPage({ ...currentPage, page: 1 });
                        }
                    }}>
                        Search
                    </Button>
                    {searchField && searchValue && (
                        <Button size="sm" variant="ghost" onClick={() => {
                            setSearchValue("");
                            setSearchField("");
                            setTimeout(() => {
                                if (currentPage.page === 1) {
                                    pageFetcher.submit(
                                        {
                                            sort: sort.field,
                                            direction: sort.direction,
                                            limit: currentPage.pageSize
                                        },
                                        { method: "POST", encType: "application/json", action: `/database/${routeParams.db}/${routeParams.col}` }
                                    );
                                } else {
                                    setCurrentPage({ ...currentPage, page: 1 });
                                }
                            }, 0);
                        }}>
                            Clear
                        </Button>
                    )}
                    <div className="ml-auto">
                        <Button size="sm" variant="ghost" icon={<SyncIcon />} hasIconOnly tooltip="Refresh" onClick={() => refreshData()} />
                    </div>
                </div>

                <div className="w-full min-h-72">{items}</div>
            </div>
            <Pagination
                className="mt-3 mb-10 text-sm"
                backwardText="Previous page"
                forwardText="Next page"
                itemsPerPageText="Items per page:"
                onChange={({ page, pageSize }) => {
                    setCurrentPage({ page, pageSize });
                }}
                page={currentPage.page}
                pageSize={currentPage.pageSize}
                pageSizes={[10, 20, 30, 40, 50, 100, 500]}
                size="md"
                totalItems={count}
            />
            <CollectionDeleteModal
                open={isDelete}
                onClose={() => setIsDelete(false)}
                collectionName={title}
                dbName={routeParams.db as string}
                onSuccess={() => {
                    setIsDelete(false);
                    navigate(`/database/${routeParams.db}`);
                }}
            />

        </>
    );
}
