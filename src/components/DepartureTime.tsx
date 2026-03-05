import { DateTime } from "luxon";
import styles from "./DepartureTime.module.css";

interface DepartureTimeProps {
  departureTime: number;
  delay: number | null | undefined;
  timezone: string;
  agencyId: string;
  tripId: string;
  stopSequence: number;
}

export default function DepartureTime({
  departureTime,
  delay,
  timezone,
  agencyId,
  tripId,
  stopSequence,
}: DepartureTimeProps) {
  const href = `/a/${agencyId}/t/${tripId}?stop=${stopSequence}`;

  const stopMidnight = DateTime.now().setZone(timezone).startOf("day");
  const depTime = stopMidnight.plus({ seconds: departureTime });

  const isNextDay = depTime.day !== stopMidnight.day;
  const timeDisplay = depTime.toFormat("h:mm a") + (isNextDay ? " (+1)" : "");

  let statusClass = styles.scheduled;
  let timeLabel = timeDisplay;

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

  return (
    <a href={href} className={styles.timeLink}>
      <span className={`${styles.timePill} ${statusClass}`}>{timeLabel}</span>
    </a>
  );
}
