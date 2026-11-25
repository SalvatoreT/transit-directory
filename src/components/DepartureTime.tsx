import type { ServiceDay } from "../service-day";
import styles from "./DepartureTime.module.css";

interface DepartureTimeProps {
  serviceDay: ServiceDay;
  departureTime: number | null;
  delay: number | null;
  status: string | null;
  timezone: string;
  agencyId: string;
  tripId: string;
  stopSequence: number;
}

export default function DepartureTime({
  serviceDay,
  departureTime,
  delay,
  status,
  timezone,
  agencyId,
  tripId,
  stopSequence,
}: DepartureTimeProps) {
  const href = `/a/${agencyId}/t/${tripId}?stop=${stopSequence}`;
  let timeLabel;
  let statusClass = styles.scheduled;

  if (status === "CANCELED" || status === "SKIPPED") {
    timeLabel = status === "CANCELED" ? "Canceled" : "Stop skipped";
    statusClass = styles.delayed;
  } else if (departureTime == null) {
    timeLabel = "Time unavailable";
  } else {
    timeLabel = serviceDay.formatTime(departureTime + (delay ?? 0), timezone);
    if (delay != null) {
      const delayMin = Math.round(delay / 60);
      if (delayMin > 0) {
        timeLabel += ` (+${delayMin})`;
        statusClass = styles.delayed;
      } else if (delayMin < 0) {
        timeLabel += ` (${delayMin})`;
        statusClass = styles.early;
      } else {
        statusClass = styles.onTime;
      }
    }
  }

  return (
    <a href={href} className={styles.timeLink}>
      <span className={`${styles.timePill} ${statusClass}`}>{timeLabel}</span>
    </a>
  );
}
