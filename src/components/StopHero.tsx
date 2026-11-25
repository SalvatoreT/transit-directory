"use client";

import { useState, useEffect } from "react";
import styles from "./StopHero.module.css";

interface StopHeroProps {
  routeColor: string;
  routeTextColor: string;
  stopName: string;
  arrivalFormatted: string | null;
  departureFormatted: string | null;
  countdownTimestamp: number | null;
  status: string | null;
}

function formatCountdown(diffMs: number): string {
  if (diffMs <= 0) return "Time passed";
  const totalSeconds = Math.ceil(diffMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}

export default function StopHero({
  routeColor,
  routeTextColor,
  stopName,
  arrivalFormatted,
  departureFormatted,
  countdownTimestamp,
  status,
}: StopHeroProps) {
  const sameTime = arrivalFormatted && arrivalFormatted === departureFormatted;
  const disruption =
    status === "CANCELED"
      ? "Trip canceled"
      : status === "SKIPPED"
        ? "Stop skipped"
        : null;
  const [countdown, setCountdown] = useState("--:--:--");

  useEffect(() => {
    if (countdownTimestamp == null || disruption) return;
    let timeout: ReturnType<typeof setTimeout>;
    const update = () => {
      clearTimeout(timeout);
      if (document.hidden) return;
      const remaining = countdownTimestamp - Date.now();
      setCountdown(formatCountdown(remaining));
      // Recheck at the exact second boundary, then stop at the predicted time.
      if (remaining > 0) timeout = setTimeout(update, remaining % 1000 || 1000);
    };
    update();
    document.addEventListener("visibilitychange", update);
    return () => {
      clearTimeout(timeout);
      document.removeEventListener("visibilitychange", update);
    };
  }, [countdownTimestamp, disruption]);

  function handleClose() {
    const url = new URL(window.location.href);
    url.searchParams.delete("stop");
    window.location.href = url.toString();
  }

  return (
    <div
      className={styles.heroBox}
      style={{
        background: `linear-gradient(135deg, ${routeColor} 0%, ${routeColor}dd 100%)`,
        color: routeTextColor,
      }}
    >
      <button
        className={styles.heroClose}
        onClick={handleClose}
        aria-label="Close"
        style={{ color: routeTextColor }}
      >
        &times;
      </button>
      <div className={styles.heroStopName}>{stopName}</div>
      <div className={styles.heroTimes}>
        {disruption ? (
          <span className={styles.heroTime}>{disruption}</span>
        ) : sameTime ? (
          <div className={styles.heroTimeBlock}>
            <span className={styles.heroLabel}>Arrival/Departure</span>
            <span className={styles.heroTime}>{arrivalFormatted}</span>
          </div>
        ) : (
          <>
            {arrivalFormatted && (
              <div className={styles.heroTimeBlock}>
                <span className={styles.heroLabel}>Arrival</span>
                <span className={styles.heroTime}>{arrivalFormatted}</span>
              </div>
            )}
            {departureFormatted && (
              <div className={styles.heroTimeBlock}>
                <span className={styles.heroLabel}>Departure</span>
                <span className={styles.heroTime}>{departureFormatted}</span>
              </div>
            )}
          </>
        )}
        {!disruption && countdownTimestamp != null && (
          <div className={styles.heroTimeBlock}>
            <span className={styles.heroLabel}>Countdown</span>
            <span
              className={`${styles.heroTime} ${styles.countdownTime} ${countdown === "Time passed" ? styles.arrived : ""}`}
            >
              {countdown}
            </span>
          </div>
        )}
        {!disruption && countdownTimestamp == null && (
          <span>Time unavailable</span>
        )}
      </div>
    </div>
  );
}
