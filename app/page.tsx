import { getAgencies } from "../src/db";
import styles from "./page.module.css";

export const dynamic = "force-dynamic";

export async function generateMetadata() {
  return {
    title: "Transit Directory",
    description: "Browse transit agencies and view real-time information.",
  };
}

export default async function HomePage() {
  const agencies = await getAgencies();

  return (
    <main className={styles.main}>
      <h1 className={styles.title}>Transit Agencies</h1>
      <ul className={styles.agencyList}>
        {agencies.map((agency) => (
          <li key={agency.agency_id}>
            <a href={`/a/${agency.agency_id}`}>{agency.agency_name}</a>
          </li>
        ))}
      </ul>
      {agencies.length === 0 && (
        <p>No active agencies found. Please check back later.</p>
      )}
    </main>
  );
}
