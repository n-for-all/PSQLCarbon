import { LoaderFunction } from "@remix-run/node";
import { getUserDbConnections, requireUser } from "~/utils/session.server";
import { detectConnections } from "~/lib/detect.server";

export const loader: LoaderFunction = async ({ request }) => {
    const user = await requireUser(request, "/login");
    try {
        const detected = await detectConnections(await getUserDbConnections(user.id));
        return Response.json({ detected }, { headers: { "Cache-Control": "no-store" } });
    } catch (e: any) {
        return Response.json({ message: e.message }, { status: 500 });
    }
};
