"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { FaRegStar, FaStar } from "react-icons/fa";
import axios from "axios";
import toast from "react-hot-toast";

type FavoriteButtonProps = {
  characterId: string;
  initialIsFavorited?: boolean;
  className?: string;
  iconSize?: number;
  onChange?: (isFavorited: boolean) => void;
};

export default function FavoriteButton({
  characterId,
  initialIsFavorited = false,
  className = "",
  iconSize = 14,
  onChange,
}: FavoriteButtonProps) {
  const { status } = useSession();
  const router = useRouter();
  const [isFavorited, setIsFavorited] = useState(initialIsFavorited);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setIsFavorited(initialIsFavorited);
  }, [initialIsFavorited, characterId]);

  const handleClick = async (e: React.MouseEvent<HTMLButtonElement>) => {
    e.preventDefault();
    e.stopPropagation();

    if (status === "unauthenticated") {
      toast.error("Войдите, чтобы добавить в избранное");
      router.push("/login");
      return;
    }

    if (loading) return;

    const action = isFavorited ? "remove" : "add";
    setLoading(true);

    try {
      const { data } = await axios.post<{ isFavorited: boolean }>("/api/favorites", {
        characterId,
        action,
      });
      setIsFavorited(data.isFavorited);
      onChange?.(data.isFavorited);
      toast.success(data.isFavorited ? "Добавлено в избранное" : "Удалено из избранного");
    } catch {
      toast.error("Не удалось обновить избранное");
    } finally {
      setLoading(false);
    }
  };

  const Icon = isFavorited ? FaStar : FaRegStar;

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={loading}
      className={`flex items-center justify-center rounded-full border border-white/10 bg-black/55 text-white backdrop-blur-sm transition-colors hover:border-wd-primary/50 disabled:opacity-60 ${isFavorited ? "text-wd-primary hover:text-wd-primary" : "hover:text-wd-primary"} ${className}`}
      aria-label={isFavorited ? "Убрать из избранного" : "Добавить в избранное"}
    >
      <Icon size={iconSize} />
    </button>
  );
}
