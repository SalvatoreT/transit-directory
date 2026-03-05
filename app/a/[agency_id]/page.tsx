import { notFound } from "next/navigation";
import { getAgency, getRoutes, getStops } from "../../../src/db";
import type { RoutesData, StopsData } from "../../../src/db";
import styles from "./page.module.css";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ agency_id: string }>;
}) {
  const { agency_id } = await params;
  const agency = await getAgency(agency_id);
  if (!agency) return { title: "Agency Not Found" };
  return {
    title: `${agency.agency_name} (${agency_id}) - Transit Directory`,
    description: `View active routes and stops for ${agency.agency_name}.`,
  };
}

function RoutesView({
  routes,
  agencyId,
}: {
  routes: RoutesData[];
  agencyId: string;
}) {
  return (
    <div className={styles.routesGrid}>
      {routes.map((route) => {
        const bgColor = route.route_color ? `#${route.route_color}` : "#eee";
        const textColor = route.route_text_color
          ? `#${route.route_text_color}`
          : "#000";
        return (
          <a
            key={route.route_pk}
            href={`/a/${agencyId}/r/${route.route_id}`}
            className={styles.routeCardLink}
          >
            <div className={styles.routeCard}>
              <div
                className={styles.routePill}
                style={{ backgroundColor: bgColor, color: textColor }}
              >
                {route.route_short_name}
              </div>
              <div className={styles.routeDetails}>
                <h2>{route.route_long_name || route.route_short_name}</h2>
                {route.route_desc && (
                  <p className={styles.routeDesc}>{route.route_desc}</p>
                )}
              </div>
              <span className={styles.chevron}>&rsaquo;</span>
            </div>
          </a>
        );
      })}
      {routes.length === 0 && <p>No routes found.</p>}
    </div>
  );
}

function StopsView({
  stops,
  agencyId,
}: {
  stops: StopsData[];
  agencyId: string;
}) {
  return (
    <div className={styles.stopsGrid}>
      {stops.map((stop) => (
        <a
          key={stop.stop_pk}
          href={`/a/${agencyId}/s/${stop.stop_id}`}
          className={styles.stopCardLink}
        >
          <div className={styles.stopCard}>
            <h2>{stop.stop_name}</h2>
            <span className={styles.chevron}>&rsaquo;</span>
          </div>
        </a>
      ))}
    </div>
  );
}

export default async function AgencyPage({
  params,
  searchParams,
}: {
  params: Promise<{ agency_id: string }>;
  searchParams: Promise<{ view?: string }>;
}) {
  const { agency_id } = await params;
  const { view: viewParam } = await searchParams;
  const agency = await getAgency(agency_id);

  if (!agency) {
    notFound();
  }

  const { agency_name, feed_version_id, agency_pk } = agency;
  const view = viewParam === "stops" ? "stops" : "routes";

  let routes: RoutesData[] = [];
  let stops: StopsData[] = [];

  if (view === "routes") {
    routes = await getRoutes({ feed_version_id, agency_pk });
  } else {
    stops = (await getStops({ feed_version_id, is_parent: true })).sort(
      (a, b) => a.stop_name.localeCompare(b.stop_name),
    );
  }

  return (
    <main className={styles.main}>
      <div className={styles.header}>
        <a href="/" className={styles.backLink}>
          &larr; Back to Transit Directory
        </a>
        <h1 className={styles.title}>
          {agency_name} <span className={styles.agencyId}>({agency_id})</span>
        </h1>
      </div>

      <div className={styles.viewToggle}>
        <a
          href={`/a/${agency_id}`}
          className={`${styles.toggleBtn} ${view === "routes" ? styles.active : ""}`}
        >
          Routes
        </a>
        <a
          href={`/a/${agency_id}?view=stops`}
          className={`${styles.toggleBtn} ${view === "stops" ? styles.active : ""}`}
        >
          Stops
        </a>
      </div>

      <p className={styles.subtitle}>
        {view === "routes" ? "Active Routes" : "Select a Stop"}
      </p>

      {view === "routes" ? (
        <RoutesView routes={routes} agencyId={agency_id} />
      ) : (
        <StopsView stops={stops} agencyId={agency_id} />
      )}
    </main>
  );
}
