import {
  LuHouse,
  LuMessagesSquare,
  LuHeart,
  LuCirclePlus,
  LuCoins,
  LuCrown,
  LuUser,
  LuCircleHelp,
} from "react-icons/lu";

export const NAV_SECTIONS = [
  [
    { nameKey: "header.menu.home", shortKey: "header.menuShort.home", path: "/", icon: LuHouse },
    {
      nameKey: "header.menu.chats",
      shortKey: "header.menuShort.chats",
      path: "/chats",
      icon: LuMessagesSquare,
      matchPaths: ["/chats", "/chat"],
      prefetch: true,
    },
    { nameKey: "header.menu.favorites", path: "/favorites", icon: LuHeart },
    {
      nameKey: "header.menu.create",
      shortKey: "header.menuShort.create",
      path: "/create",
      icon: LuCirclePlus,
      matchPaths: ["/create", "/edit"],
    },
  ],
  [
    {
      nameKey: "header.menu.coins",
      shortKey: "header.menuShort.coins",
      path: "/coins",
      icon: LuCoins,
      prefetch: true,
    },
    {
      nameKey: "header.menu.pricing",
      path: "/pricing",
      icon: LuCrown,
      matchPaths: ["/pricing", "/subscription"],
      prefetch: true,
    },
    { nameKey: "header.menu.profile", shortKey: "header.menuShort.profile", path: "/profile", icon: LuUser },
    { nameKey: "header.menu.support", path: "/support", icon: LuCircleHelp },
  ],
];

const ALL_ITEMS = NAV_SECTIONS.flat();

export const BOTTOM_NAV_ITEMS = ["/", "/chats", "/create", "/coins", "/profile"].map((path) =>
  ALL_ITEMS.find((item) => item.path === path)
);

export function isNavItemActive(item, pathname) {
  const paths = item.matchPaths ?? [item.path];

  return paths.some((path) => {
    if (path === "/") return pathname === "/";
    return pathname === path || pathname.startsWith(`${path}/`);
  });
}
