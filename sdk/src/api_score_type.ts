export type Root = Root2[]

export interface Root2 {
  categories: Category[]
  divisionName: string
  round: string
  groupName: string
  orgGroupIdentifier: string
  totalScore: number
  rank: number
  subtotalScore: number
  subtotalRank: number
  active: boolean
  isOtherType: boolean
  competition: Competition
}

export interface Category {
  Captions: Caption[]
  Name: string
  Score: string
  Rank: number
}

export interface Caption {
  Subcaptions: Subcaption[]
  JudgeFirstName: string
  JudgeLastName: string
  Judge: number
  Name: string
  Initials: string
  Score: string
  Rank: number
}

export interface Subcaption {
  Name: string
  Initials: string
  Score: string
  Rank: number
}

export interface Competition {
  groupTypes: GroupType[]
  eventName: string
  location: string
  date: string
  competitionLevel: number
  chiefJudge: string
  scoresReleased: boolean
  recapReleased: boolean
  categoryRecapReleased: boolean
  seasonName: string
  slug: string
}

export interface GroupType {
  id: number
  name: string
  competitionType: CompetitionType
}

export interface CompetitionType {
  id: number
  name: string
}
