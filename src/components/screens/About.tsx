import { ArrowLeft, CloudRain, Gamepad2, Globe, Mail, MapPin, Timer, TrainFront, Users } from 'lucide-react';
import { motion } from 'motion/react';
import { back } from '../../game/actions';

const team = [
  {
    role: 'Main dev',
    name: 'Srijon Karmakar',
    email: 'srijonkarmakar.dev@gmail.com',
  },
  {
    role: 'Assistant dev',
    name: 'Subhranil Banargee',
    email: 'subhranilbanrg@gmail.com',
  },
];

export function AboutScreen() {
  return (
    <motion.div className="screen about" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: { duration: 0.22 } }}>
      <div className="scrim-top" />
      <div className="scrim-bottom" />

      <div className="topbar">
        <button className="icon-btn glass" aria-label="Back to home" onClick={back}>
          <ArrowLeft size={21} />
        </button>
        <div className="title">
          <h2>About Us</h2>
          <p>PublicPort team and game details</p>
        </div>
      </div>

      <div className="about-body">
        <motion.section
          className="about-panel glass-strong"
          initial={{ opacity: 0, y: 18 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ type: 'spring', stiffness: 260, damping: 26 }}
        >
          <div className="about-mark">
            <img src="/favicon-updated.png" alt="PublicPort" />
          </div>
          <div className="eyebrow">About this game</div>
          <h1>PublicPort</h1>
          <p>
            PublicPort is an OpenStreetMap-powered transit driving simulator where players explore real metro, train, tram, bus, and ferry routes. Pick a city, run a route, stop accurately, follow the timetable, and keep passengers comfortable from start to finish.
          </p>

          <div className="about-facts">
            <div className="about-fact">
              <span className="ico"><Gamepad2 size={19} /></span>
              <div>
                <b>Transit simulator</b>
                <small>Live map-based public transport routes</small>
              </div>
            </div>
            <div className="about-fact">
              <span className="ico"><MapPin size={19} /></span>
              <div>
                <b>Kolkata</b>
                <small>Project location</small>
              </div>
            </div>
          </div>
          <div className="eyebrow" style={{ marginTop: 18 }}>What you can do</div>
          <ul className="about-features">
            <li><Globe size={16} /> Pick any city on Earth; routes load live from OpenStreetMap</li>
            <li><TrainFront size={16} /> Drive metro, train, tram, monorail, bus and ferry lines in 3D, cab or 2D view</li>
            <li><Timer size={16} /> Keep to a real timetable, stop on the mark and board passengers</li>
            <li><CloudRain size={16} /> Real day/night lighting and live weather that changes how you brake</li>
          </ul>
        </motion.section>

        <motion.section
          className="about-team glass"
          initial={{ opacity: 0, y: 18 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ type: 'spring', stiffness: 260, damping: 26, delay: 0.08 }}
        >
          <div className="section-title about-team-title">
            <span className="eyebrow">Development team</span>
            <Users size={18} />
          </div>

          {team.map((member) => (
            <a key={member.email} className="team-row" href={`mailto:${member.email}`}>
              <span className="team-avatar">{member.name.split(' ').map((part) => part[0]).join('').slice(0, 2)}</span>
              <span className="team-main">
                <b>{member.name}</b>
                <small>{member.role}</small>
                <small className="team-email">{member.email}</small>
              </span>
              <span className="team-mail" aria-label={`Email ${member.name}`}>
                <Mail size={17} />
              </span>
            </a>
          ))}
          <p className="about-made">
            <MapPin size={14} /> Made in Kolkata, India · Map data © OpenStreetMap contributors
          </p>
        </motion.section>
      </div>
    </motion.div>
  );
}