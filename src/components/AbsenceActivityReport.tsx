"use client";

import { useEffect, useState } from "react";
import axios from "axios";

export type AbsenceActivityEvent = {
  id: string;
  type: string;
  description: string;
  location: string | null;
  timestamp: string;
};

function formatEventTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("ru-RU", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function AbsenceActivityReport({ characterId }: { characterId: string }) {
  const [events, setEvents] = useState<AbsenceActivityEvent[] | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    let cancelled = false;

    axios
      .get<{ events: AbsenceActivityEvent[] }>(`/api/characters/${characterId}/activity`)
      .then(({ data }) => {
        if (cancelled) return;
        const list = Array.isArray(data.events) ? data.events : [];
        setEvents(list);
        setVisible(true);
      })
      .catch(() => {
        if (!cancelled) {
          setEvents(null);
          setVisible(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [characterId]);

  if (!visible || events === null) {
    return null;
  }

  return (
    <section className="rounded-xl border border-[#2A2A2A] bg-black/40 p-3 text-left">
      <h3 className="text-sm font-semibold text-white">Что произошло в твоё отсутствие</h3>
      {events.length === 0 ? (
        <p className="mt-2 text-sm text-secondary-text">Пока ничего не произошло</p>
      ) : (
        <ul className="mt-2 space-y-2">
          {events.map((event) => (
            <li key={event.id} className="text-sm leading-snug text-gray-200">
              {formatEventTime(event.timestamp) ? (
                <span className="mr-2 text-xs text-gray-500">{formatEventTime(event.timestamp)}</span>
              ) : null}
              <span>{event.description}</span>
              {event.location ? (
                <span className="ml-1 text-xs text-[#C8C4FF]">({event.location})</span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
