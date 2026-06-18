// To parse this data:
//
//   import { Convert } from "./file";
//
//   const dciSeason = Convert.toDciSeason(json);
//
// These functions will throw an error if the JSON doesn't
// match the expected interface, even if the JSON is valid.

export type DciSeason = {
	[x: string]: Appearances[]
}

export interface Appearances {
	categories: SubcaptionOverallScore[]
	divisionName: DivisionName
	round: string
	groupName: string
	orgGroupIdentifier: string
	totalScore: number
	rank: number
	subtotalScore: number
	subtotalRank: number
	competitionGUID: string
	active: boolean
	isOtherType: boolean
	competition: Competition
}

export interface Caption {
	subcaptions: SubcaptionOverallScore[]
	judgeFirstName: null | string
	judgeLastName: null | string
	judge: number
	name: CaptionName
	initials: CaptionInitials
	score: string
	rank: number
}

export interface SubcaptionOverallScore {
	captions?: Caption[]
	name: CategoryName
	score: string
	rank: number
	initials?: CategoryInitials
}

export type CaptionInitials = 'GE 1' | 'GE 2' | 'VP' | 'VA' | 'CG' | 'BRS' | 'MA' | 'Perc' | 'PEN'

export type CaptionName =
	| 'General Effect 1'
	| 'General Effect 2'
	| 'Visual Proficiency'
	| 'Visual - Analysis'
	| 'Color Guard'
	| 'Music - Brass'
	| 'Music - Analysis'
	| 'Music - Percussion'
	| 'Penalties'

export type CategoryInitials = 'Rep' | 'Perf' | 'Cont' | 'Achv' | 'Comp' | 'CONT' | 'Pen'

export type CategoryName = 'General Effect' | 'Visual' | 'Music' | 'Timing & Penalties' | 'Repertoire' | 'Performance' | 'Content' | 'Achievement' | 'Composition' | 'Penalties'

export interface Competition {
	groupTypes: GroupType[]
	eventName: string
	location: string
	date: Date
	competitionGUID: string
	competitionLevel: number
	chiefJudge: string
	scoresReleased: boolean
	recapReleased: boolean
	categoryRecapReleased: boolean
	seasonGUID: string
	seasonName: string
	slug: string
}

export interface GroupType {
	id: number
	name: GroupTypeName
	competitionType: CompetitionType
}

export interface CompetitionType {
	id: number
	name: CompetitionTypeName
}

export type CompetitionTypeName = '8 Judge' | 'General'

export type GroupTypeName = 'Marching' | 'SoundSport'

export type DivisionName = 'World Class' | 'Open Class' | 'All Age Class'

// Converts JSON strings to/from your types
// and asserts the results of JSON.parse at runtime
export class Convert {
	public static toDciSeason(json: string): DciSeason {
		return cast(JSON.parse(json), r('DciSeason'))
	}

	public static dciSeasonToJson(value: DciSeason): string {
		return JSON.stringify(uncast(value, r('DciSeason')), null, 2)
	}

	public static toCaption(json: string): Caption {
		return cast(JSON.parse(json), r('Caption'))
	}

	public static captionToJson(value: Caption): string {
		return JSON.stringify(uncast(value, r('Caption')), null, 2)
	}

	public static toCategory(json: string): SubcaptionOverallScore {
		return cast(JSON.parse(json), r('Category'))
	}

	public static categoryToJson(value: SubcaptionOverallScore): string {
		return JSON.stringify(uncast(value, r('Category')), null, 2)
	}

	public static toCompetition(json: string): Competition {
		return cast(JSON.parse(json), r('Competition'))
	}

	public static competitionToJson(value: Competition): string {
		return JSON.stringify(uncast(value, r('Competition')), null, 2)
	}

	public static toGroupType(json: string): GroupType {
		return cast(JSON.parse(json), r('GroupType'))
	}

	public static groupTypeToJson(value: GroupType): string {
		return JSON.stringify(uncast(value, r('GroupType')), null, 2)
	}

	public static toCompetitionType(json: string): CompetitionType {
		return cast(JSON.parse(json), r('CompetitionType'))
	}

	public static competitionTypeToJson(value: CompetitionType): string {
		return JSON.stringify(uncast(value, r('CompetitionType')), null, 2)
	}
}

function invalidValue(typ: any, val: any, key: any, parent: any = ''): never {
	const prettyTyp = prettyTypeName(typ)
	const parentText = parent ? ` on ${parent}` : ''
	const keyText = key ? ` for key "${key}"` : ''
	throw Error(`Invalid value${keyText}${parentText}. Expected ${prettyTyp} but got ${JSON.stringify(val)}`)
}

function prettyTypeName(typ: any): string {
	if (Array.isArray(typ)) {
		if (typ.length === 2 && typ[0] === undefined) {
			return `an optional ${prettyTypeName(typ[1])}`
		} else {
			return `one of [${typ
				.map((a) => {
					return prettyTypeName(a)
				})
				.join(', ')}]`
		}
	} else if (typeof typ === 'object' && typ.literal !== undefined) {
		return typ.literal
	} else {
		return typeof typ
	}
}

function jsonToJSProps(typ: any): any {
	if (typ.jsonToJS === undefined) {
		const map: any = {}
		typ.props.forEach((p: any) => (map[p.json] = { key: p.js, typ: p.typ }))
		typ.jsonToJS = map
	}
	return typ.jsonToJS
}

function jsToJSONProps(typ: any): any {
	if (typ.jsToJSON === undefined) {
		const map: any = {}
		typ.props.forEach((p: any) => (map[p.js] = { key: p.json, typ: p.typ }))
		typ.jsToJSON = map
	}
	return typ.jsToJSON
}

function transform(val: any, typ: any, getProps: any, key: any = '', parent: any = ''): any {
	function transformPrimitive(typ: string, val: any): any {
		if (typeof typ === typeof val) return val
		return invalidValue(typ, val, key, parent)
	}

	function transformUnion(typs: any[], val: any): any {
		// val must validate against one typ in typs
		const l = typs.length
		for (let i = 0; i < l; i++) {
			const typ = typs[i]
			try {
				return transform(val, typ, getProps)
			} catch (_) {}
		}
		return invalidValue(typs, val, key, parent)
	}

	function transformEnum(cases: string[], val: any): any {
		if (cases.indexOf(val) !== -1) return val
		return invalidValue(
			cases.map((a) => {
				return l(a)
			}),
			val,
			key,
			parent
		)
	}

	function transformArray(typ: any, val: any): any {
		// val must be an array with no invalid elements
		if (!Array.isArray(val)) return invalidValue(l('array'), val, key, parent)
		return val.map((el) => transform(el, typ, getProps))
	}

	function transformDate(val: any): any {
		if (val === null) {
			return null
		}
		const d = new Date(val)
		if (isNaN(d.valueOf())) {
			return invalidValue(l('Date'), val, key, parent)
		}
		return d
	}

	function transformObject(props: { [k: string]: any }, additional: any, val: any): any {
		if (val === null || typeof val !== 'object' || Array.isArray(val)) {
			return invalidValue(l(ref || 'object'), val, key, parent)
		}
		const result: any = {}
		Object.getOwnPropertyNames(props).forEach((key) => {
			const prop = props[key]
			const v = Object.prototype.hasOwnProperty.call(val, key) ? val[key] : undefined
			result[prop.key] = transform(v, prop.typ, getProps, key, ref)
		})
		Object.getOwnPropertyNames(val).forEach((key) => {
			if (!Object.prototype.hasOwnProperty.call(props, key)) {
				result[key] = transform(val[key], additional, getProps, key, ref)
			}
		})
		return result
	}

	if (typ === 'any') return val
	if (typ === null) {
		if (val === null) return val
		return invalidValue(typ, val, key, parent)
	}
	if (typ === false) return invalidValue(typ, val, key, parent)
	let ref: any = undefined
	while (typeof typ === 'object' && typ.ref !== undefined) {
		ref = typ.ref
		typ = typeMap[typ.ref]
	}
	if (Array.isArray(typ)) return transformEnum(typ, val)
	if (typeof typ === 'object') {
		return typ.hasOwnProperty('unionMembers')
			? transformUnion(typ.unionMembers, val)
			: typ.hasOwnProperty('arrayItems')
			? transformArray(typ.arrayItems, val)
			: typ.hasOwnProperty('props')
			? transformObject(getProps(typ), typ.additional, val)
			: invalidValue(typ, val, key, parent)
	}
	// Numbers can be parsed by Date but shouldn't be.
	if (typ === Date && typeof val !== 'number') return transformDate(val)
	return transformPrimitive(typ, val)
}

function cast<T>(val: any, typ: any): T {
	return transform(val, typ, jsonToJSProps)
}

function uncast<T>(val: T, typ: any): any {
	return transform(val, typ, jsToJSONProps)
}

function l(typ: any) {
	return { literal: typ }
}

function a(typ: any) {
	return { arrayItems: typ }
}

function u(...typs: any[]) {
	return { unionMembers: typs }
}

function o(props: any[], additional: any) {
	return { props, additional }
}

function m(additional: any) {
	return { props: [], additional }
}

function r(name: string) {
	return { ref: name }
}

const typeMap: any = {
	DciSeason: o(
		[
			{ json: 'categories', js: 'categories', typ: a(r('Category')) },
			{ json: 'divisionName', js: 'divisionName', typ: r('DivisionName') },
			{ json: 'round', js: 'round', typ: '' },
			{ json: 'groupName', js: 'groupName', typ: '' },
			{ json: 'orgGroupIdentifier', js: 'orgGroupIdentifier', typ: '' },
			{ json: 'totalScore', js: 'totalScore', typ: 3.14 },
			{ json: 'rank', js: 'rank', typ: 0 },
			{ json: 'subtotalScore', js: 'subtotalScore', typ: 3.14 },
			{ json: 'subtotalRank', js: 'subtotalRank', typ: 0 },
			{ json: 'competitionGuid', js: 'competitionGUID', typ: '' },
			{ json: 'active', js: 'active', typ: true },
			{ json: 'isOtherType', js: 'isOtherType', typ: true },
			{ json: 'competition', js: 'competition', typ: r('Competition') },
		],
		false
	),
	Caption: o(
		[
			{ json: 'Subcaptions', js: 'subcaptions', typ: a(r('Category')) },
			{ json: 'JudgeFirstName', js: 'judgeFirstName', typ: u(null, '') },
			{ json: 'JudgeLastName', js: 'judgeLastName', typ: u(null, '') },
			{ json: 'Judge', js: 'judge', typ: 0 },
			{ json: 'Name', js: 'name', typ: r('CaptionName') },
			{ json: 'Initials', js: 'initials', typ: r('CaptionInitials') },
			{ json: 'Score', js: 'score', typ: '' },
			{ json: 'Rank', js: 'rank', typ: 0 },
		],
		false
	),
	Category: o(
		[
			{ json: 'Captions', js: 'captions', typ: u(undefined, a(r('Caption'))) },
			{ json: 'Name', js: 'name', typ: r('CategoryName') },
			{ json: 'Score', js: 'score', typ: '' },
			{ json: 'Rank', js: 'rank', typ: 0 },
			{ json: 'Initials', js: 'initials', typ: u(undefined, r('CategoryInitials')) },
		],
		false
	),
	Competition: o(
		[
			{ json: 'groupTypes', js: 'groupTypes', typ: a(r('GroupType')) },
			{ json: 'eventName', js: 'eventName', typ: '' },
			{ json: 'location', js: 'location', typ: '' },
			{ json: 'date', js: 'date', typ: Date },
			{ json: 'competitionGuid', js: 'competitionGUID', typ: '' },
			{ json: 'competitionLevel', js: 'competitionLevel', typ: 0 },
			{ json: 'chiefJudge', js: 'chiefJudge', typ: '' },
			{ json: 'scoresReleased', js: 'scoresReleased', typ: true },
			{ json: 'recapReleased', js: 'recapReleased', typ: true },
			{ json: 'categoryRecapReleased', js: 'categoryRecapReleased', typ: true },
			{ json: 'seasonGuid', js: 'seasonGUID', typ: '' },
			{ json: 'seasonName', js: 'seasonName', typ: '' },
			{ json: 'slug', js: 'slug', typ: '' },
		],
		false
	),
	GroupType: o(
		[
			{ json: 'id', js: 'id', typ: 0 },
			{ json: 'name', js: 'name', typ: r('GroupTypeName') },
			{ json: 'competitionType', js: 'competitionType', typ: r('CompetitionType') },
		],
		false
	),
	CompetitionType: o(
		[
			{ json: 'id', js: 'id', typ: 0 },
			{ json: 'name', js: 'name', typ: r('CompetitionTypeName') },
		],
		false
	),
	CaptionInitials: ['BRS', 'CG', 'GE 1', 'GE 2', 'MA', 'PEN', 'Perc', 'VA', 'VP'],
	CaptionName: [
		'Color Guard',
		'General Effect 1',
		'General Effect 2',
		'Music - Analysis',
		'Music - Brass',
		'Music - Percussion',
		'Penalties',
		'Visual - Analysis',
		'Visual Proficiency',
	],
	CategoryInitials: ['Achv', 'Comp', 'Cont', 'CONT', 'Pen', 'Perf', 'Rep'],
	CategoryName: ['Achievement', 'Composition', 'Content', 'General Effect', 'Music', 'Penalties', 'Performance', 'Repertoire', 'Timing & Penalties', 'Visual'],
	CompetitionTypeName: ['General', '8 Judge'],
	GroupTypeName: ['Marching', 'SoundSport'],
	DivisionName: ['Open Class', 'World Class'],
}
