export type CoinBalances = {
  verseCoins: number;
  permanentCoins: number;
};

export function getPermanentCoins(user: { permanentCoins?: number | null }): number {
  return Math.max(0, user.permanentCoins ?? 0);
}

export function getExpiringCoins(user: {
  verseCoins: number;
  permanentCoins?: number | null;
}): number {
  return Math.max(0, user.verseCoins - getPermanentCoins(user));
}

export function grantPermanentUpdate(amount: number) {
  return {
    verseCoins: { increment: amount },
    permanentCoins: { increment: amount },
  };
}

export function setExpiringGrant(permanentCoins: number, expiringGrant: number): CoinBalances {
  const permanent = getPermanentCoins({ permanentCoins });
  return {
    verseCoins: permanent + Math.max(0, expiringGrant),
    permanentCoins: permanent,
  };
}

export function expireExpiringCoins(permanentCoins: number): CoinBalances {
  const permanent = getPermanentCoins({ permanentCoins });
  return {
    verseCoins: permanent,
    permanentCoins: permanent,
  };
}

export function spendCoins(user: CoinBalances, amount: number): CoinBalances {
  const cost = Math.max(0, amount);
  const permanent = getPermanentCoins(user);
  const expiring = getExpiringCoins(user);
  const fromExpiring = Math.min(expiring, cost);
  const fromPermanent = cost - fromExpiring;

  return {
    verseCoins: Math.max(0, user.verseCoins - cost),
    permanentCoins: Math.max(0, permanent - fromPermanent),
  };
}

export function serializeCoinBalances(user: {
  verseCoins: number;
  permanentCoins?: number | null;
}) {
  const permanentCoins = getPermanentCoins(user);
  const expiringCoins = getExpiringCoins(user);
  return {
    verseCoins: user.verseCoins,
    permanentCoins,
    expiringCoins,
  };
}

export function applySubscriptionCoinGrant(
  user: { id?: string; verseCoins?: number; permanentCoins?: number | null },
  vcGrant: number,
  expire = false
): CoinBalances {
  const permanent = getPermanentCoins(user);
  const beforeExpiring =
    typeof user.verseCoins === "number" ? getExpiringCoins({ verseCoins: user.verseCoins, permanentCoins: permanent }) : 0;
  const shouldExpire = expire || vcGrant <= 0;
  const next = shouldExpire ? expireExpiringCoins(permanent) : setExpiringGrant(permanent, vcGrant);

  if (shouldExpire) {
    if (beforeExpiring > 0) {
      console.log(
        `[Coins] Expiring burned: user=${user.id ?? "unknown"} burned=${beforeExpiring} remainingPermanent=${next.permanentCoins}`
      );
    }
  } else {
    console.log(
      `[Coins] Expiring granted: user=${user.id ?? "unknown"} grant=${vcGrant} expiring=${getExpiringCoins(next)} permanent=${next.permanentCoins}`
    );
  }

  return next;
}
