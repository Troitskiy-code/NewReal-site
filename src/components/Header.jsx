"use client";

import Link from "next/link";
import Image from "next/image";
import { FaBars } from "react-icons/fa";
import Logo from "./Logo";
import UserAvatarMenu from "./UserAvatarMenu";
import { useSidebar } from "./SidebarContext";

export default function Header() {
  const { toggle, isExpanded, isMobile } = useSidebar();

  return (
    <header className="fixed top-0 left-0 right-0 z-[60] m-0 h-14 border-b-2 border-[#2A2A2A] bg-[#1A1A1A]/80 px-0 shadow-lg shadow-black/40 backdrop-blur-sm md:h-20">
      <div className="relative flex h-full w-full items-center">
        <button
          type="button"
          onClick={toggle}
          className="absolute left-0 top-0 z-[60] m-0 flex h-full w-14 items-center justify-center rounded-none border-0 border-r border-[#2A2A2A] bg-[#121212] p-0 text-[#A0A0A0] transition-colors hover:border-[#6C63FF]/50 hover:text-white"
          aria-label={
            isMobile
              ? isExpanded
                ? "Закрыть меню"
                : "Открыть меню"
              : isExpanded
                ? "Свернуть меню"
                : "Развернуть меню"
          }
          aria-expanded={isExpanded}
        >
          <FaBars size={24} />
        </button>

        <div className="flex w-full items-center justify-between pr-4 md:pr-6">
          <Link href="/" className="ml-14 flex min-w-0 items-center gap-2 md:gap-3">
            <Image
              src="/logo.png"
              alt="NewVerse"
              width={45}
              height={45}
              className="h-7 w-7 shrink-0 md:h-10 md:w-10 lg:h-[45px] lg:w-[45px]"
              priority
            />
            <Logo size="sm" className="truncate text-base md:text-2xl lg:text-3xl" />
          </Link>

          <div className="shrink-0">
            <UserAvatarMenu />
          </div>
        </div>
      </div>
    </header>
  );
}
