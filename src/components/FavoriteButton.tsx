"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { FaHeart, FaRegHeart } from "react-icons/fa";
import axios from "axios";
import { showError, showSuccess } from "@/lib/toast";

type FavoriteButtonProps = {
  characterId: string;
  initialIsFavorited?: boolean;
  className?: string;
  iconSize?: number;
  onChange?: (isFavorited: boolean) => void;
};

export default function FavoriteButton(props: FavoriteButtonProps) {
  return <FavoriteToggle key={props.characterId} {...props} />;
}

function FavoriteToggle({
  characterId,
  initialIsFavorited = false,
  className = "",
  iconSize = 14,
  onChange,
}: FavoriteButtonProps) {
  const { status } = useSession();
  const router = useRouter();
  const [isFavorited, setIsFavorited] = useState(initialIsFavorited);
  const [previousInitial, setPreviousInitial] = useState(initialIsFavorited);
  const [loading, setLoading] = useState(false);
  const mounted = useRef(true);
  const inFlight = useRef(false);

  // Update changed server data before commit, retaining the focused button.
  if (previousInitial !== initialIsFavorited) {
    setPreviousInitial(initialIsFavorited);
    setIsFavorited(initialIsFavorited);
  }

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const handleClick = async (e: React.MouseEvent<HTMLButtonElement>) => {
    e.preventDefault();
    e.stopPropagation();

    if (status === "unauthenticated") {
      showError("Войдите, чтобы добавить в избранное");
      router.push("/login");
      return;
    }

    if (inFlight.current) return;

    const action = isFavorited ? "remove" : "add";
    inFlight.current = true;
    setLoading(true);

    try {
      const { data } = await axios.post<{ isFavorited: boolean }>("/api/favorites", {
        characterId,
        action,
      });
      if (!mounted.current) return;
      setIsFavorited(data.isFavorited);
      onChange?.(data.isFavorited);
      showSuccess(data.isFavorited ? "Добавлено в избранное" : "Удалено из избранного");
    } catch {
      if (mounted.current) showError("Не удалось обновить избранное");
    } finally {
      inFlight.current = false;
      if (mounted.current) setLoading(false);
    }
  };

  const Icon = isFavorited ? FaHeart : FaRegHeart;

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={loading}
      className={`flex items-center justify-center rounded-full border border-white/10 bg-black/55 backdrop-blur-sm transition-colors hover:border-wd-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-wd-secondary focus-visible:ring-offset-2 focus-visible:ring-offset-wd-bg disabled:opacity-60 ${isFavorited ? "text-wd-primary hover:text-wd-primary" : "text-white hover:text-wd-primary"} ${className}`}
      aria-label={isFavorited ? "Убрать из избранного" : "Добавить в избранное"}
      aria-pressed={isFavorited}
      aria-busy={loading}
    >
      <Icon size={iconSize} />
    </button>
  );
}
