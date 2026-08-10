"use client";

import Link from "next/link";
import { useSession, signOut } from "next-auth/react";
import { useState, useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { FaUser, FaCog, FaBell, FaSignInAlt, FaSignOutAlt } from "react-icons/fa";
import toast from "react-hot-toast";

function getInitials(name, email) {
  const source = (name || email || "U").trim();
  const parts = source.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
  return source.slice(0, 2).toUpperCase();
}

export default function UserAvatarMenu() {
  const { data: session, status } = useSession();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const menuRef = useRef(null);

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) {
        setOpen(false);
      }
    };
    if (open) document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open]);

  if (status === "loading") {
    return <div className="h-8 w-8 animate-pulse rounded-full bg-[#2A2A2A] md:h-10 md:w-10" />;
  }

  if (status === "unauthenticated") {
    return (
      <Link
        href="/login"
        className="flex h-8 w-8 items-center justify-center rounded-full border border-[#2A2A2A] bg-[#0A0A0A] text-white transition-colors hover:bg-[#2A2A2A] md:h-10 md:w-10"
        title="Войти"
      >
        <FaSignInAlt size={16} className="md:hidden" />
        <FaSignInAlt size={18} className="hidden md:block" />
      </Link>
    );
  }

  const user = session?.user;
  const initials = getInitials(user?.name, user?.email);
  const isProfileActive = pathname === "/profile" || pathname.startsWith("/edit/");

  const dropdownItems = [
    { name: "Профиль", path: "/profile", icon: FaUser, active: isProfileActive },
    {
      name: "Настройки",
      stub: true,
      icon: FaCog,
      message: "Настройки скоро будут доступны",
    },
    {
      name: "Уведомления",
      stub: true,
      icon: FaBell,
      message: "Уведомления скоро будут доступны",
    },
  ];

  return (
    <div ref={menuRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className="flex h-8 w-8 items-center justify-center overflow-hidden rounded-full border-2 border-[#2A2A2A] bg-[#0A0A0A] transition-colors hover:border-[#4A90D9]/50 md:h-10 md:w-10"
        aria-label="Меню профиля"
        aria-expanded={open}
      >
        {user?.image ? (
          <img src={user.image} alt={user.name || "Профиль"} className="h-full w-full object-cover" />
        ) : (
          <span className="text-xs font-bold text-white">{initials}</span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-2 min-w-[200px] overflow-hidden rounded-lg border border-[#2A2A2A] bg-[#1A1A1A] py-1 shadow-xl">
          {user?.name && (
            <div className="border-b border-[#2A2A2A] px-4 py-3">
              <p className="truncate text-sm font-bold text-white">{user.name}</p>
              {user.email && <p className="truncate text-xs text-[#A0A0A0]">{user.email}</p>}
            </div>
          )}

          <ul className="py-1">
            {dropdownItems.map((item) => {
              const Icon = item.icon;
              const itemClass = `flex w-full items-center gap-3 px-4 py-2.5 text-sm transition-colors ${
                item.active
                  ? "bg-[#4A90D9]/15 text-[#4A90D9]"
                  : "text-white hover:bg-[#2A2A2A]"
              }`;

              if (item.stub) {
                return (
                  <li key={item.name}>
                    <button
                      type="button"
                      className={itemClass}
                      onClick={() => {
                        toast(item.message, { icon: "🔜" });
                        setOpen(false);
                      }}
                    >
                      <Icon size={16} className="shrink-0" />
                      {item.name}
                    </button>
                  </li>
                );
              }

              return (
                <li key={item.name}>
                  <Link href={item.path} className={itemClass} onClick={() => setOpen(false)}>
                    <Icon size={16} className="shrink-0" />
                    {item.name}
                  </Link>
                </li>
              );
            })}
          </ul>

          <div className="border-t border-[#2A2A2A] py-1">
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                signOut({ callbackUrl: "/login" });
              }}
              className="flex w-full items-center gap-3 px-4 py-2.5 text-sm text-[#FF2D55] transition-colors hover:bg-[#2A2A2A]"
            >
              <FaSignOutAlt size={16} />
              Выйти
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
