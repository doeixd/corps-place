import type {
  CompetitionsQuery,
  EventsQuery,
  FilterExpression,
  GalleriesQuery,
  PerformancesQuery,
  PerformanceCorpsQuery
} from "./service.js";

type DateInput = string | Date;

const normalizeDate = (value: DateInput) => (value instanceof Date ? value.toISOString().split("T")[0]! : value);

export class CompetitionsQueryBuilder {
  constructor(private readonly query: CompetitionsQuery = {}) {}

  private with(patch: Partial<CompetitionsQuery>) {
    return new CompetitionsQueryBuilder({ ...this.query, ...patch });
  }

  private compare(key: "startDate" | "endDate", expression: FilterExpression<string | Date>) {
    return this.with({ [key]: expression } as Partial<CompetitionsQuery>);
  }

  season(value: string | number) {
    return this.with({ season: value });
  }

  slug(value: string) {
    return this.with({ slug: value });
  }

  region(value: string) {
    return this.with({ region: value });
  }

  state(value: string) {
    return this.with({ state: value });
  }

  location(value: string) {
    return this.with({ location: value });
  }

  division(value: string) {
    return this.with({ division: value });
  }

  class(value: string) {
    return this.with({ class: value });
  }

  sort(value: string) {
    return this.with({ sort: value });
  }

  viewMode(value: string) {
    return this.with({ viewMode: value });
  }

  search(value: string) {
    return this.with({ search: value });
  }

  limit(value: number) {
    return this.with({ limit: value });
  }

  perPage(value: number) {
    return this.with({ perPage: value });
  }

  page(value: number) {
    return this.with({ page: value });
  }

  startDateAfter(value: DateInput) {
    return this.compare("startDate", { op: ">", value: normalizeDate(value) });
  }

  startDateOnOrAfter(value: DateInput) {
    return this.compare("startDate", { op: ">=", value: normalizeDate(value) });
  }

  startDateBefore(value: DateInput) {
    return this.compare("startDate", { op: "<", value: normalizeDate(value) });
  }

  endDateBefore(value: DateInput) {
    return this.compare("endDate", { op: "<", value: normalizeDate(value) });
  }

  build(): CompetitionsQuery {
    return { ...this.query };
  }
}

export class EventsQueryBuilder {
  constructor(private readonly query: EventsQuery = {}) {}

  private with(patch: Partial<EventsQuery>) {
    return new EventsQueryBuilder({ ...this.query, ...patch });
  }

  private compare(key: "startDate" | "endDate", expression: FilterExpression<string | Date>) {
    return this.with({ [key]: expression } as Partial<EventsQuery>);
  }

  season(season: string | number) {
    return this.with({ season });
  }

  corp(id: string) {
    return this.with({ corpId: id });
  }

  region(value: string) {
    return this.with({ region: value });
  }

  state(value: string) {
    return this.with({ state: value });
  }

  viewMode(mode: string) {
    return this.with({ viewMode: mode });
  }

  sort(value: string) {
    return this.with({ sort: value });
  }

  limit(value: number) {
    return this.with({ limit: value });
  }

  page(value: number) {
    return this.with({ page: value });
  }

  perPage(value: number) {
    return this.with({ perPage: value });
  }

  startDateAfter(value: DateInput) {
    return this.compare("startDate", { op: ">", value: normalizeDate(value) });
  }

  startDateOnOrAfter(value: DateInput) {
    return this.compare("startDate", { op: ">=", value: normalizeDate(value) });
  }

  startDateBefore(value: DateInput) {
    return this.compare("startDate", { op: "<", value: normalizeDate(value) });
  }

  endDateBefore(value: DateInput) {
    return this.compare("endDate", { op: "<", value: normalizeDate(value) });
  }

  search(term: string) {
    return this.with({ search: term });
  }

  build(): EventsQuery {
    return { ...this.query };
  }
}

export class GalleriesQueryBuilder {
  constructor(private readonly query: GalleriesQuery = {}) {}

  private with(patch: Partial<GalleriesQuery>) {
    return new GalleriesQueryBuilder({ ...this.query, ...patch });
  }

  corp(id: string) {
    return this.with({ corpId: id });
  }

  tags(...tags: string[]) {
    const next = Array.isArray(this.query.tags) ? this.query.tags : this.query.tags ? [this.query.tags] : [];
    return this.with({ tags: [...next, ...tags] });
  }

  type(value: number) {
    return this.with({ type: value });
  }

  page(value: number) {
    return this.with({ page: value });
  }

  perPage(value: number) {
    return this.with({ perPage: value });
  }

  sort(value: string) {
    return this.with({ sort: value });
  }

  build(): GalleriesQuery {
    return { ...this.query };
  }
}

export class PerformancesQueryBuilder {
  constructor(private readonly query: PerformancesQuery = {}) {}

  private with(patch: Partial<PerformancesQuery>) {
    return new PerformancesQueryBuilder({ ...this.query, ...patch });
  }

  private compare(key: "startDate" | "endDate", expression: FilterExpression<string | Date>) {
    return this.with({ [key]: expression } as Partial<PerformancesQuery>);
  }

  season(value: string | number) {
    return this.with({ season: value });
  }

  corp(name: string) {
    return this.with({ corp: name });
  }

  slug(value: string) {
    return this.with({ slug: value });
  }

  division(value: string) {
    return this.with({ division: value });
  }

  class(value: string) {
    return this.with({ class: value });
  }

  sort(value: string) {
    return this.with({ sort: value });
  }

  perPage(value: number) {
    return this.with({ perPage: value });
  }

  page(value: number) {
    return this.with({ page: value });
  }

  startDateAfter(value: DateInput) {
    return this.compare("startDate", { op: ">", value: normalizeDate(value) });
  }

  endDateBefore(value: DateInput) {
    return this.compare("endDate", { op: "<", value: normalizeDate(value) });
  }

  build(): PerformancesQuery {
    return { ...this.query };
  }
}

export class PerformanceCorpsQueryBuilder {
  constructor(private readonly query: PerformanceCorpsQuery = {}) {}

  private with(patch: Partial<PerformanceCorpsQuery>) {
    return new PerformanceCorpsQueryBuilder({ ...this.query, ...patch });
  }

  class(value: string) {
    return this.with({ class: value });
  }

  sort(value: string) {
    return this.with({ sort: value });
  }

  build(): PerformanceCorpsQuery {
    return { ...this.query };
  }
}
export const eventsQuery = () => new EventsQueryBuilder();
export const galleriesQuery = () => new GalleriesQueryBuilder();
export const performancesQuery = () => new PerformancesQueryBuilder();
export const performanceCorpsQuery = () => new PerformanceCorpsQueryBuilder();
export const competitionsQuery = () => new CompetitionsQueryBuilder();
