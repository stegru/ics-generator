// usage: node ics.js [options.json5] > output.ics
const fs = require("fs");

const optionsFile = process.argv[2];
const tzPath = __dirname + "/../fantastical/Contributed/libical/zoneinfo"

const defaultOptions = {
  /** number of items to generate */
  items: 10,
  /** earliest date */
  start: new Date(),
  /** to number of days after start */
  daySpan: 14,

  minDuration: 15,
  maxDuration: 120,

  method: "publish",

  chances: {
    task: 0.1,
    allDay: 0.2,
    multiDay: 0.2,
    recurring: 0.1,
    meeting: 0.3,
  },

  // Number of minutes times and durations get rounded to
  roundTo: 5,

  timezones: [
    "", "Europe/London", "Asia/Tokyo", "America/New_York", "Europe/Berlin", "Africa/Cairo", "Australia/Sydney", "Etc/UTC", "Etc/GMT+12"
  ],
};

// read options from json5 file
const json5 = optionsFile && fs.readFileSync(optionsFile, "utf8");
const loaded = json5 && require("vm").runInNewContext(`(${json5})`);
const options = loaded
  ? { ...defaultOptions, ...loaded }
  : defaultOptions;

if (typeof(options.start) === "string") {
  // Allow the date support "today", "next week"
  const date = require("child_process").execSync(`date --date="${options.start}" --iso-8601=seconds`, { encoding: "utf8" }).trim();
  options.start = new Date(date);
}

const people = [];
const timezonesUsed = {};

const icsData = {
  $type: "vcalendar",
  version: "2.0",
  prodid: "-//example//test data//EN",
  method: options.method?.toUpperCase() || "PUBLISH",
  timezones: [],
}

icsData.items = generateItems();
const lines = toICS(icsData);
lines.push("");

if (options.outfile) {
  fs.writeFileSync(options.outfile, lines.join("\r\n"));
} else {
  process.stdout.write(lines.join("\r\n"));
}

return;

function generateItems() {
  const items = [];
  for (let i = 0; i < options.items; i++) {
    items.push(generateEvent());
  }
  return items;
}

function generateEvent() {
  let start = randomTime(options.start, options.daySpan);
  let end = new Date(start.getTime() + roundToMinutes(randomInt(options.minDuration * 60000, options.maxDuration * 60000)));

  const rand = getRandomOptions(options.chances);

  rand.event = !rand.task;

  if (rand.allDay || rand.multiDay) {
    start.setHours(0, 0, 0, 0);
    end = new Date(start);

    const days = rand.multiDay ? randomInt(2, 5) : 1;
    rand.allDay = true;
    end.setDate(end.getDate() + days);
  }

  let item = {
    $type: rand.task ? "vtodo" : "vevent",
    uid: uid(),
    dtstamp: new Date(),
    summary: "Test Event " + Object.keys(rand).join(","),
  }

  start = {
    $props: {},
    value: start,
  };
  end = {
    $props: {},
    value: end,
  }

  if (rand.allDay) {
    start.$props.value = "DATE";
    end.$props.value = "DATE";
  }

  const tz = getRandomValue(options.timezones);
  if (tz) {
    start.$props.tzid = tz;
    end.$props.tzid = tz;

    if (!timezonesUsed[tz]) {
      timezonesUsed[tz] = true;
      icsData.timezones.push([...readTZ(tz)]);
    }
  }

  if (rand.task) {
    if (!rand.allDay) {
      item.due = start;
    }
  } else {
    item = {
      ...item,
      dtstart: start,
      dtend: end,
    }
  }

  if (rand.recurring) {
    const rule = {
      freq: getRandomValue("DAILY", "WEEKLY", "MONTHLY", "YEARLY"),
      interval: randomInt(5) || undefined,
      count: randomInt(20) || undefined,
    };

    item.rrule = makePropertyString(rule);
  }

  if (rand.event && rand.meeting) {
    const people = getRandomPeople(randomInt(1, 6)).map(p => {
      return {
        $props: {CN: p.name},
        value: `mailto:${p.email}`,
      }
    });
    item.organizer = people.shift();
    item.attendees = people.map(p => { return { ...p, key: "attendee" }});
  }

  return item;
}

/**
 * Convert an object into ics format
 * @returns {string[]}
 */
function toICS(obj, lines = [])
{
  // Add strings as-is
  if (typeof(obj) === "string") {
    lines.push(obj);
    return lines;
  }

  // Add string arrays as multiple lines
  if (Array.isArray(obj) && typeof(obj[0]) === "string") {
    lines.push(...obj);
    return lines;
  }

  if (obj.$props) {
    // Single object with properties
    obj = [obj];
  }

  const isComponent = !!obj.$type;
  if (isComponent) {
    lines.push("BEGIN:" + obj.$type.toUpperCase());
  }

  // Add each key-value pair to the output
  for (let key in obj) {
    if (key.charAt(0) === "$") {
      continue;
    }

    let value = obj[key];

    const props = value.$props;
    const propsString = makePropertyString(props);

    if (props) {
      // { $props: {property: "value"}, value: "value", key: "key" }
      key = (value.key || key).toUpperCase();
      if (propsString) {
        key += `;${propsString}`;
      }
      value = value.value;
    } else {
      key = key.toUpperCase();
    }

    if (value instanceof Date) {
      value = value.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z/, "");

      if (props?.value === "DATE") {
        value = value.replace(/T.*/, "");
      } else if (!props?.tzid) {
        value = value += "Z";
      }
    }

    if (Array.isArray(value)) {
      value.forEach(item => toICS(item, lines));
    } else if (typeof value === "object") {
      toICS(value, lines);
    } else {
      // add "KEY:VALUE"
      lines.push(`${key}:${value}`);
    }
  }

  if (isComponent) {
    lines.push("END:" + obj.$type.toUpperCase());
  }
  return lines;
}

/**
 * @returns {string} "KEY1=VALUE1;KEY2=VALUE2"
 */
function makePropertyString(props) {
  return props && Object.entries(props).map(([k, v]) => {
    return v === undefined ? undefined : `${k.toUpperCase()}=${v}`;
  }).filter(a => !!a).join(";");
}


/**
 * @param {Date} from
 * @returns {Date} */
function randomTime(from, days) {
  const time = roundToMinutes(from.getTime() + Math.random() * (days * 24 * 60 * 60 * 1000));
  return new Date(time);
}

/** @returns {number} */
function roundToMinutes(time, mins = options.roundTo) {
  const ms = mins * 60000;
  return Math.round(time / ms) * ms;
}

function uid() {
  return Math.random().toString(36).substring(2, 10) + "@test";
}

function randomInt(min, max) {
  if (max === undefined) {
    max = min;
    min = 0;
  }
  return Math.floor(Math.random() * (max - min) + min);
}

function getRandomValue(...values) {
  if (values.length === 1 && Array.isArray(values[0])) {
    values = values[0];
  }
  return values[randomInt(values.length)];
}

/**
 * Returns an object with keys set to true based on the chances
 */
function getRandomOptions(chances) {
  const values = {};
  for (let key in chances) {
    if (Math.random() < chances[key]) {
      values[key] = true;
    }
  }
  return values;
}


/**
 * @returns {{name: string, email: string}[]}
 */
function getRandomPeople(count) {
  const people = [];
  while (people.length < count) {
    const p = getRandomPerson();
    if (people.find(a => a.email === p.email)) {
      continue;
    }
    people.push(p);
  }
  return people;
}

/**
 * @returns {{name: string, email: string}}
 */
function getRandomPerson() {
  if (!people.length) {
    for (let i = 0; i < 10; i++) {
      const name = randomName();
      const person = {
        name,
        email: randomEmail(name),
      };
      people.push(person);
    }
  }

  return getRandomValue(people);
}

function randomName() {
  if (!options.names) {
    options.names = {
      first: ["Gassy", "Crusty", "Fidget", "Skid", "Greasy", "Pimply", "Booger", "Burpy", "Clammy", "Soggy", "Warty", "Sniffy", "Grunty"],
      last: ["McNugget", "O’Doodle", "Buttersniff", "Fuzzbucket", "Crotchley", "Spankleton", "Stinklebop", "Poopins", "Wifflebottom", "McCrackle", "Sogbottom"],
    };
  }

  const name = {};
  for (let n of ["first", "last"]) {
    let attempts = 0;
    do {
      name[n] = getRandomValue(options.names[n]);
    } while (++attempts < 5 && people.find(p => p.name.includes(name[n])));
  }

  return `${name.first} ${name.last}`;
}

function randomEmail(name = undefined) {
  if (!name) {
    name = randomName();
  }

  name = name.toLowerCase().replace(/[^a-z ]/g, "");
  if (Math.random() < 0.5) {
    name = name.replace(/(?<=.).* /, "");
  }
  return name.replace(/ /g, getRandomValue(".", "", "-")) + "@example.com";
}

function readTZ(tz) {
  const path = require("path").join(tzPath, `${tz}.ics`);
  let on = false;
  const lines = fs.readFileSync(path, "utf8")
    .replace(/^TZID:.*$/m, `TZID:${tz}`)
    .split(/[\r\n]+/)
    .filter(line => {
      if (line.startsWith("BEGIN:VTIMEZONE")) {
        on = true;
      } else if (line.startsWith("END:VTIMEZONE")) {
        on = false;
      } else {
        return on;
      }
      return true;
    });
  return lines;
}
