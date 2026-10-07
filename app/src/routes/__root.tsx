import {
  createRootRoute,
  HeadContent,
  Outlet,
  Scripts,
} from "@tanstack/react-router";
import "../styles.css";
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
        <Outlet />
        <Scripts />
      </body>
    </html>
  ),
});
