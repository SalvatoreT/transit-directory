"use client";

import { useState, useEffect } from "react";
import { DateTime } from "luxon";
import styles from "./StopHero.module.css";

interface StopHeroProps {
  routeColor: string;
  routeTextColor: string;
  stopName: string;
  arrivalSeconds: number | null;
  departureSeconds: number | null;
  delay: number;
  timezone: string;
}

function formatCountdown(diffMs: number): string {
  if (diffMs <= 0) return "Arrived";
  const totalSeconds = Math.floor(diffMs / 1000);
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
  arrivalSeconds,
  departureSeconds,
  delay,
  timezone,
}: StopHeroProps) {
  const midnight = DateTime.now().setZone(timezone).startOf("day");

  const arrivalTime =
    arrivalSeconds != null
      ? midnight.plus({ seconds: arrivalSeconds + delay })
      : null;
  const departureTime =
    departureSeconds != null
      ? midnight.plus({ seconds: departureSeconds + delay })
      : null;

  const arrivalFormatted = arrivalTime?.toFormat("h:mm a");
  const departureFormatted = departureTime?.toFormat("h:mm a");
  const sameTime =
    arrivalFormatted &&
    departureFormatted &&
    arrivalFormatted === departureFormatted;

  const countdownTime = arrivalTime || departureTime;
  const countdownTimestamp = countdownTime?.toMillis() || 0;

  const [countdown, setCountdown] = useState("--:--:--");
  const [arrived, setArrived] = useState(false);

  useEffect(() => {
    function update() {
      if (!countdownTimestamp) return;
      const diff = countdownTimestamp - Date.now();
      if (diff <= 0) {
        setCountdown("Arrived");
        setArrived(true);
      } else {
        setCountdown(formatCountdown(diff));
      }
    }
    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, [countdownTimestamp]);

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
        {sameTime ? (
          <div className={styles.heroTimeBlock}>
            <span className={styles.heroLabel}>Arrival/Departure</span>
            <span className={styles.heroTime}>{arrivalFormatted}</span>
          </div>
        ) : (
          <>
            {arrivalTime && (
              <div className={styles.heroTimeBlock}>
                <span className={styles.heroLabel}>Arrival</span>
                <span className={styles.heroTime}>{arrivalFormatted}</span>
              </div>
            )}
            {departureTime && (
              <div className={styles.heroTimeBlock}>
                <span className={styles.heroLabel}>Departure</span>
                <span className={styles.heroTime}>{departureFormatted}</span>
              </div>
            )}
          </>
        )}
        <div className={styles.heroTimeBlock}>
          <span className={styles.heroLabel}>Countdown</span>
          <span
            className={`${styles.heroTime} ${styles.countdownTime} ${arrived ? styles.arrived : ""}`}
          >
            {countdown}
          </span>
        </div>
      </div>
    </div>
  );
}
