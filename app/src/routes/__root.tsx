import {
  createRootRoute,
  HeadContent,
  Outlet,
  Scripts,
} from "@tanstack/react-router";
import "../styles.css";
import { AuthProvider } from "../components/auth-provider";
export const Route = createRootRoute({
  head: () => ({
    meta: [
      { title: "Godiffy" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
    ],
  }),
  component: () => (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        <AuthProvider>
          <Outlet />
        </AuthProvider>
        <Scripts />
      </body>
    </html>
  ),
});
