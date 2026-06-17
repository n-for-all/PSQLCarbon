import { LoaderFunction } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import db, { ConnectionData } from "~/lib/db";
import { Table, TableBody, TableCell, TableRow } from "~/ui/table";
import { getUserSession } from "~/utils/session.server";

export const loader: LoaderFunction = async ({ request }) => {
    const session = await getUserSession(request);
    const connection = session.get("connection");

    let mongo: ConnectionData;

    try {
        mongo = await db(connection);
    } catch (error) {
        return Response.json({ status: "error", message: "Could not connect to database" }, { status: 500 });
    }

    const pool = mongo.getPool();
    let version = "Unknown";
    let uptime = "N/A";

    if (pool) {
        try {
            const res = await pool.query("SELECT version();");
            version = res.rows[0].version;

            // Try to get uptime if pg_postmaster_start_time is available
            const uptimeRes = await pool.query("SELECT extract(epoch from (now() - pg_postmaster_start_time())) as uptime;");
            uptime = uptimeRes.rows[0].uptime;
        } catch (e) {
            console.error(e);
        }
    }

    return Response.json(
        { info: { version, uptime }, versions: process.versions },
        {
            headers: {
                "Cache-Control": "no-store",
            },
        }
    );
};

export default function Dashboard() {
    const loaderData = useLoaderData<typeof loader>();
    const info = loaderData?.info;
    const versions = loaderData?.versions;

    return (
        <div>
            <div className="pb-4">
                <h4 className="text-xl font-medium">Server Information</h4>
                <p className="text-sm">Version: {info?.version}</p>
            </div>
            <div className="flex flex-col pb-4 lg:flex-row">
                <div className="flex-1 w-full">
                    <Table className="flex-1 w-full bg-neutral-100 text-md">
                        <TableBody>
                            <TableRow className="border-b">
                                <TableCell className="px-4 py-2 font-semibold">Node Version</TableCell>
                                <TableCell className="px-4 py-2">{versions?.node}</TableCell>
                            </TableRow>
                            <TableRow className="border-b">
                                <TableCell className="px-4 py-2 font-semibold">V8 Version</TableCell>
                                <TableCell className="px-4 py-2">{versions?.v8}</TableCell>
                            </TableRow>
                        </TableBody>
                    </Table>
                </div>
                <div className="flex-1 w-full">
                    <Table className="bg-neutral-100 text-md">
                        <TableBody>
                            <TableRow className="border-b">
                                <TableCell className="px-4 py-2 font-semibold">Uptime</TableCell>
                                <TableCell className="px-4 py-2">
                                    {info?.uptime} seconds
                                </TableCell>
                            </TableRow>
                        </TableBody>
                    </Table>
                </div>
            </div>
        </div>
    );
}
