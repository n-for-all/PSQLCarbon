import { redirect, type ActionFunction, type LoaderFunction } from "@remix-run/node";
import { isDesktop, logout } from "../utils/session.server";
export const action: ActionFunction = async ({ request }) => {
	return logout(request);
};
export const loader: LoaderFunction = async ({ request }) => {
    if (isDesktop()) {
        return redirect("/");
    }
    return logout(request);
};
