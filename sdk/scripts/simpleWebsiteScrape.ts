

async function getEventPage(slug: string) {
  const response = await fetch(`https://www.dci.org/events/${slug}`)
  const text = await response.text()
  return text
}

const directChildOf = (parent: string, child: string) => `${parent} > ${child}`
const childOf = (parent: string, child: string) => `${parent} ${child}`

const data = {
  date: directChildOf(".inner-hero-inner", "p:nth-child(1)"),
  title: directChildOf(".inner-hero-inner", "h1"),
  locationCityState: directChildOf(".inner-hero-inner", ".location"),
  watchLiveLink: ".watch-live",
  buyTicketsLink: ".buy-tickets-btn a.btn",
  about: ".common-section div div div .common-dis",
  ticketsSection: ".upcoming-events",
  ticket: childOf(".upcoming-events", ".upcoming-events-info"),
  ticketTitle: childOf(".upcoming-events-info", ".event-ticket-title"),
  ticketDescription: childOf(".upcoming-events-info", ".common-dis ~ .event-ticket-price"),
  ticketInfo: childOf(".upcoming-events-info", ".event-ticket-info"),
  ticketPrice: childOf(".upcoming-events-info", ".event-ticket-price"),
  ticketBuyLink: childOf(".upcoming-events-info", ".arrow-link > a"),
  lineupsSection: '.lineup-times-section',
  lineupsTable: childOf(".lineup-times-section", "table"),
  lineup: childOf(".lineup-times-section", "table tr"),
  lineupCorps: childOf(".lineup-times-section", "table tr td:nth-child(2)"),
  lineupTime: childOf(".lineup-times-section", "table tr td:nth-child(1)"),
  eventLocationSection: '.event-location',
  eventLocationAddress: childOf(".event-location", ".event-info > address"),
  eventLocationGoogleMapLink: childOf(".event-location", ".event-info a"),
  eventLocationGoogleMapIframe: childOf(".event-location", ".event-location-maps iframe"),
  eventLocationImages: childOf(".event-location", "img"),
}



const text = await getEventPage("2024-dci-world-championships-finals")

const parser = new DOMParser()
const doc = parser.parseFromString(text, "text/html")

const corps = doc.querySelectorAll(".corps-score")

console.log(corps.length)