-- Drop existing f1db tables if they exist
DROP TABLE IF EXISTS race_constructor_standing CASCADE;
DROP TABLE IF EXISTS race_driver_standing CASCADE;
DROP TABLE IF EXISTS race_data CASCADE;
DROP TABLE IF EXISTS race CASCADE;
DROP TABLE IF EXISTS season_constructor_standing CASCADE;
DROP TABLE IF EXISTS season_driver_standing CASCADE;
DROP TABLE IF EXISTS season_entrant_tyre_manufacturer CASCADE;
DROP TABLE IF EXISTS season_entrant_engine CASCADE;
DROP TABLE IF EXISTS season_entrant_chassis CASCADE;
DROP TABLE IF EXISTS season_entrant_constructor CASCADE;
DROP TABLE IF EXISTS season_entrant_driver CASCADE;
DROP TABLE IF EXISTS season_entrant CASCADE;
DROP TABLE IF EXISTS season_tyre_manufacturer CASCADE;
DROP TABLE IF EXISTS season_engine_manufacturer CASCADE;
DROP TABLE IF EXISTS season_constructor CASCADE;
DROP TABLE IF EXISTS season_driver CASCADE;
DROP TABLE IF EXISTS season CASCADE;
DROP TABLE IF EXISTS grand_prix CASCADE;
DROP TABLE IF EXISTS circuit CASCADE;
DROP TABLE IF EXISTS entrant CASCADE;
DROP TABLE IF EXISTS tyre_manufacturer CASCADE;
DROP TABLE IF EXISTS engine CASCADE;
DROP TABLE IF EXISTS engine_manufacturer CASCADE;
DROP TABLE IF EXISTS chassis CASCADE;
DROP TABLE IF EXISTS constructor_chronology CASCADE;
DROP TABLE IF EXISTS constructor CASCADE;
DROP TABLE IF EXISTS driver_family_relationship CASCADE;
DROP TABLE IF EXISTS driver CASCADE;
DROP TABLE IF EXISTS country CASCADE;
DROP TABLE IF EXISTS continent CASCADE;

CREATE TABLE "continent" (
  "id" varchar(100) NOT NULL,
  "code" varchar(2) NOT NULL,
  "name" varchar(100) NOT NULL,
  "demonym" varchar(100) NOT NULL,
  PRIMARY KEY ("id"),
  UNIQUE ("code"),
  UNIQUE ("name")
);
CREATE TABLE "country" (
  "id" varchar(100) NOT NULL,
  "alpha2_code" varchar(2) NOT NULL,
  "alpha3_code" varchar(3) NOT NULL,
  "ioc_code" varchar(3),
  "name" varchar(100) NOT NULL,
  "demonym" varchar(100),
  "continent_id" varchar(100) NOT NULL,
  PRIMARY KEY ("id"),
  UNIQUE ("alpha2_code"),
  UNIQUE ("alpha3_code"),
  UNIQUE ("name"),
  FOREIGN KEY ("continent_id") REFERENCES "continent" ("id")
);
CREATE TABLE "driver" (
  "id" varchar(100) NOT NULL,
  "name" varchar(100) NOT NULL,
  "first_name" varchar(100) NOT NULL,
  "last_name" varchar(100) NOT NULL,
  "full_name" varchar(100) NOT NULL,
  "abbreviation" varchar(3) NOT NULL,
  "permanent_number" varchar(2),
  "gender" varchar(6) NOT NULL,
  "date_of_birth" date NOT NULL,
  "date_of_death" date,
  "place_of_birth" varchar(100) NOT NULL,
  "country_of_birth_country_id" varchar(100) NOT NULL,
  "nationality_country_id" varchar(100) NOT NULL,
  "second_nationality_country_id" varchar(100),
  "best_championship_position" int,
  "best_starting_grid_position" int,
  "best_race_result" int,
  "best_sprint_race_result" int,
  "total_championship_wins" int NOT NULL,
  "total_race_entries" int NOT NULL,
  "total_race_starts" int NOT NULL,
  "total_race_wins" int NOT NULL,
  "total_race_laps" int NOT NULL,
  "total_podiums" int NOT NULL,
  "total_points" decimal(8, 2) NOT NULL,
  "total_championship_points" decimal(8, 2) NOT NULL,
  "total_pole_positions" int NOT NULL,
  "total_fastest_laps" int NOT NULL,
  "total_sprint_race_starts" int NOT NULL,
  "total_sprint_race_wins" int NOT NULL,
  "total_driver_of_the_day" int NOT NULL,
  "total_grand_slams" int NOT NULL,
  PRIMARY KEY ("id"),
  FOREIGN KEY ("country_of_birth_country_id") REFERENCES "country" ("id"),
  FOREIGN KEY ("nationality_country_id") REFERENCES "country" ("id"),
  FOREIGN KEY ("second_nationality_country_id") REFERENCES "country" ("id")
);
CREATE TABLE "driver_family_relationship" (
  "driver_id" varchar(100) NOT NULL,
  "position_display_order" int NOT NULL,
  "other_driver_id" varchar(100) NOT NULL,
  "type" varchar(50) NOT NULL,
  PRIMARY KEY ("driver_id", "position_display_order"),
  UNIQUE ("driver_id", "other_driver_id", "type"),
  FOREIGN KEY ("driver_id") REFERENCES "driver" ("id"),
  FOREIGN KEY ("other_driver_id") REFERENCES "driver" ("id")
);
CREATE TABLE "constructor" (
  "id" varchar(100) NOT NULL,
  "name" varchar(100) NOT NULL,
  "full_name" varchar(100) NOT NULL,
  "country_id" varchar(100) NOT NULL,
  "best_championship_position" int,
  "best_starting_grid_position" int,
  "best_race_result" int,
  "best_sprint_race_result" int,
  "total_championship_wins" int NOT NULL,
  "total_race_entries" int NOT NULL,
  "total_race_starts" int NOT NULL,
  "total_race_wins" int NOT NULL,
  "total_1_and_2_finishes" int NOT NULL,
  "total_race_laps" int NOT NULL,
  "total_podiums" int NOT NULL,
  "total_podium_races" int NOT NULL,
  "total_points" decimal(8, 2) NOT NULL,
  "total_championship_points" decimal(8, 2) NOT NULL,
  "total_pole_positions" int NOT NULL,
  "total_fastest_laps" int NOT NULL,
  "total_sprint_race_starts" int NOT NULL,
  "total_sprint_race_wins" int NOT NULL,
  PRIMARY KEY ("id"),
  FOREIGN KEY ("country_id") REFERENCES "country" ("id")
);
CREATE TABLE "constructor_chronology" (
  "constructor_id" varchar(100) NOT NULL,
  "position_display_order" int NOT NULL,
  "other_constructor_id" varchar(100) NOT NULL,
  "year_from" int NOT NULL,
  "year_to" int,
  PRIMARY KEY ("constructor_id", "position_display_order"),
  UNIQUE ("constructor_id", "other_constructor_id", "year_from", "year_to"),
  FOREIGN KEY ("constructor_id") REFERENCES "constructor" ("id"),
  FOREIGN KEY ("other_constructor_id") REFERENCES "constructor" ("id")
);
CREATE TABLE "chassis" (
  "id" varchar(100) NOT NULL,
  "constructor_id" varchar(100) NOT NULL,
  "name" varchar(100) NOT NULL,
  "full_name" varchar(100) NOT NULL,
  PRIMARY KEY ("id"),
  FOREIGN KEY ("constructor_id") REFERENCES "constructor" ("id")
);
CREATE TABLE "engine_manufacturer" (
  "id" varchar(100) NOT NULL,
  "name" varchar(100) NOT NULL,
  "country_id" varchar(100) NOT NULL,
  "best_championship_position" int,
  "best_starting_grid_position" int,
  "best_race_result" int,
  "best_sprint_race_result" int,
  "total_championship_wins" int NOT NULL,
  "total_race_entries" int NOT NULL,
  "total_race_starts" int NOT NULL,
  "total_race_wins" int NOT NULL,
  "total_race_laps" int NOT NULL,
  "total_podiums" int NOT NULL,
  "total_podium_races" int NOT NULL,
  "total_points" decimal(8, 2) NOT NULL,
  "total_championship_points" decimal(8, 2) NOT NULL,
  "total_pole_positions" int NOT NULL,
  "total_fastest_laps" int NOT NULL,
  "total_sprint_race_starts" int NOT NULL,
  "total_sprint_race_wins" int NOT NULL,
  PRIMARY KEY ("id"),
  FOREIGN KEY ("country_id") REFERENCES "country" ("id")
);
CREATE TABLE "engine" (
  "id" varchar(100) NOT NULL,
  "engine_manufacturer_id" varchar(100) NOT NULL,
  "name" varchar(100) NOT NULL,
  "full_name" varchar(100) NOT NULL,
  "capacity" decimal(2, 1),
  "configuration" varchar(100),
  "aspiration" varchar(100),
  PRIMARY KEY ("id"),
  FOREIGN KEY ("engine_manufacturer_id") REFERENCES "engine_manufacturer" ("id")
);
CREATE TABLE "tyre_manufacturer" (
  "id" varchar(100) NOT NULL,
  "name" varchar(100) NOT NULL,
  "country_id" varchar(100) NOT NULL,
  "best_starting_grid_position" int,
  "best_race_result" int,
  "best_sprint_race_result" int,
  "total_race_entries" int NOT NULL,
  "total_race_starts" int NOT NULL,
  "total_race_wins" int NOT NULL,
  "total_race_laps" int NOT NULL,
  "total_podiums" int NOT NULL,
  "total_podium_races" int NOT NULL,
  "total_pole_positions" int NOT NULL,
  "total_fastest_laps" int NOT NULL,
  "total_sprint_race_starts" int NOT NULL,
  "total_sprint_race_wins" int NOT NULL,
  PRIMARY KEY ("id"),
  FOREIGN KEY ("country_id") REFERENCES "country" ("id")
);
CREATE TABLE "entrant" (
  "id" varchar(100) NOT NULL,
  "name" varchar(100) NOT NULL,
  PRIMARY KEY ("id")
);
CREATE TABLE "circuit" (
  "id" varchar(100) NOT NULL,
  "name" varchar(100) NOT NULL,
  "full_name" varchar(100) NOT NULL,
  "previous_names" varchar(255),
  "type" varchar(6) NOT NULL,
  "direction" varchar(14) NOT NULL,
  "place_name" varchar(100) NOT NULL,
  "country_id" varchar(100) NOT NULL,
  "latitude" decimal(10, 6) NOT NULL,
  "longitude" decimal(10, 6) NOT NULL,
  "length" decimal(6, 3) NOT NULL,
  "turns" int NOT NULL,
  "total_races_held" int NOT NULL,
  PRIMARY KEY ("id"),
  FOREIGN KEY ("country_id") REFERENCES "country" ("id")
);
CREATE TABLE "grand_prix" (
  "id" varchar(100) NOT NULL,
  "name" varchar(100) NOT NULL,
  "full_name" varchar(100) NOT NULL,
  "short_name" varchar(100) NOT NULL,
  "abbreviation" varchar(3) NOT NULL,
  "country_id" varchar(100),
  "total_races_held" int NOT NULL,
  PRIMARY KEY ("id"),
  FOREIGN KEY ("country_id") REFERENCES "country" ("id")
);
CREATE TABLE "season" (
  "year" int NOT NULL,
  PRIMARY KEY ("year")
);
CREATE TABLE "season_entrant" (
  "year" int NOT NULL,
  "entrant_id" varchar(100) NOT NULL,
  "country_id" varchar(100) NOT NULL,
  PRIMARY KEY ("year", "entrant_id"),
  FOREIGN KEY ("country_id") REFERENCES "country" ("id"),
  FOREIGN KEY ("entrant_id") REFERENCES "entrant" ("id"),
  FOREIGN KEY ("year") REFERENCES "season" ("year")
);
CREATE TABLE "season_entrant_constructor" (
  "year" int NOT NULL,
  "entrant_id" varchar(100) NOT NULL,
  "constructor_id" varchar(100) NOT NULL,
  "engine_manufacturer_id" varchar(100) NOT NULL,
  PRIMARY KEY ("year", "entrant_id", "constructor_id", "engine_manufacturer_id"),
  FOREIGN KEY ("constructor_id") REFERENCES "constructor" ("id"),
  FOREIGN KEY ("engine_manufacturer_id") REFERENCES "engine_manufacturer" ("id"),
  FOREIGN KEY ("entrant_id") REFERENCES "entrant" ("id"),
  FOREIGN KEY ("year") REFERENCES "season" ("year")
);
CREATE TABLE "season_entrant_chassis" (
  "year" int NOT NULL,
  "entrant_id" varchar(100) NOT NULL,
  "constructor_id" varchar(100) NOT NULL,
  "engine_manufacturer_id" varchar(100) NOT NULL,
  "chassis_id" varchar(100) NOT NULL,
  PRIMARY KEY (
    "year",
    "entrant_id",
    "constructor_id",
    "engine_manufacturer_id",
    "chassis_id"
  ),
  FOREIGN KEY ("chassis_id") REFERENCES "chassis" ("id"),
  FOREIGN KEY ("constructor_id") REFERENCES "constructor" ("id"),
  FOREIGN KEY ("engine_manufacturer_id") REFERENCES "engine_manufacturer" ("id"),
  FOREIGN KEY ("entrant_id") REFERENCES "entrant" ("id"),
  FOREIGN KEY ("year") REFERENCES "season" ("year")
);
CREATE TABLE "season_entrant_engine" (
  "year" int NOT NULL,
  "entrant_id" varchar(100) NOT NULL,
  "constructor_id" varchar(100) NOT NULL,
  "engine_manufacturer_id" varchar(100) NOT NULL,
  "engine_id" varchar(100) NOT NULL,
  PRIMARY KEY (
    "year",
    "entrant_id",
    "constructor_id",
    "engine_manufacturer_id",
    "engine_id"
  ),
  FOREIGN KEY ("constructor_id") REFERENCES "constructor" ("id"),
  FOREIGN KEY ("engine_id") REFERENCES "engine" ("id"),
  FOREIGN KEY ("engine_manufacturer_id") REFERENCES "engine_manufacturer" ("id"),
  FOREIGN KEY ("entrant_id") REFERENCES "entrant" ("id"),
  FOREIGN KEY ("year") REFERENCES "season" ("year")
);
CREATE TABLE "season_entrant_tyre_manufacturer" (
  "year" int NOT NULL,
  "entrant_id" varchar(100) NOT NULL,
  "constructor_id" varchar(100) NOT NULL,
  "engine_manufacturer_id" varchar(100) NOT NULL,
  "tyre_manufacturer_id" varchar(100) NOT NULL,
  PRIMARY KEY (
    "year",
    "entrant_id",
    "constructor_id",
    "engine_manufacturer_id",
    "tyre_manufacturer_id"
  ),
  FOREIGN KEY ("constructor_id") REFERENCES "constructor" ("id"),
  FOREIGN KEY ("engine_manufacturer_id") REFERENCES "engine_manufacturer" ("id"),
  FOREIGN KEY ("entrant_id") REFERENCES "entrant" ("id"),
  FOREIGN KEY ("tyre_manufacturer_id") REFERENCES "tyre_manufacturer" ("id"),
  FOREIGN KEY ("year") REFERENCES "season" ("year")
);
CREATE TABLE "season_entrant_driver" (
  "year" int NOT NULL,
  "entrant_id" varchar(100) NOT NULL,
  "constructor_id" varchar(100) NOT NULL,
  "engine_manufacturer_id" varchar(100) NOT NULL,
  "driver_id" varchar(100) NOT NULL,
  "rounds" varchar(100),
  "rounds_text" varchar(100),
  "test_driver" boolean NOT NULL,
  PRIMARY KEY (
    "year",
    "entrant_id",
    "constructor_id",
    "engine_manufacturer_id",
    "driver_id"
  ),
  FOREIGN KEY ("constructor_id") REFERENCES "constructor" ("id"),
  FOREIGN KEY ("driver_id") REFERENCES "driver" ("id"),
  FOREIGN KEY ("engine_manufacturer_id") REFERENCES "engine_manufacturer" ("id"),
  FOREIGN KEY ("entrant_id") REFERENCES "entrant" ("id"),
  FOREIGN KEY ("year") REFERENCES "season" ("year")
);
CREATE TABLE "season_constructor" (
  "year" int NOT NULL,
  "constructor_id" varchar(100) NOT NULL,
  "position_number" int,
  "position_text" varchar(4),
  "best_starting_grid_position" int,
  "best_race_result" int,
  "best_sprint_race_result" int,
  "total_race_entries" int NOT NULL,
  "total_race_starts" int NOT NULL,
  "total_race_wins" int NOT NULL,
  "total_1_and_2_finishes" int NOT NULL,
  "total_race_laps" int NOT NULL,
  "total_podiums" int NOT NULL,
  "total_podium_races" int NOT NULL,
  "total_points" decimal(8, 2) NOT NULL,
  "total_pole_positions" int NOT NULL,
  "total_fastest_laps" int NOT NULL,
  "total_sprint_race_starts" int NOT NULL,
  "total_sprint_race_wins" int NOT NULL,
  PRIMARY KEY ("year", "constructor_id"),
  FOREIGN KEY ("constructor_id") REFERENCES "constructor" ("id"),
  FOREIGN KEY ("year") REFERENCES "season" ("year")
);
CREATE TABLE "season_engine_manufacturer" (
  "year" int NOT NULL,
  "engine_manufacturer_id" varchar(100) NOT NULL,
  "position_number" int,
  "position_text" varchar(4),
  "best_starting_grid_position" int,
  "best_race_result" int,
  "best_sprint_race_result" int,
  "total_race_entries" int NOT NULL,
  "total_race_starts" int NOT NULL,
  "total_race_wins" int NOT NULL,
  "total_race_laps" int NOT NULL,
  "total_podiums" int NOT NULL,
  "total_podium_races" int NOT NULL,
  "total_points" decimal(8, 2) NOT NULL,
  "total_pole_positions" int NOT NULL,
  "total_fastest_laps" int NOT NULL,
  "total_sprint_race_starts" int NOT NULL,
  "total_sprint_race_wins" int NOT NULL,
  PRIMARY KEY ("year", "engine_manufacturer_id"),
  FOREIGN KEY ("engine_manufacturer_id") REFERENCES "engine_manufacturer" ("id"),
  FOREIGN KEY ("year") REFERENCES "season" ("year")
);
CREATE TABLE "season_tyre_manufacturer" (
  "year" int NOT NULL,
  "tyre_manufacturer_id" varchar(100) NOT NULL,
  "best_starting_grid_position" int,
  "best_race_result" int,
  "best_sprint_race_result" int,
  "total_race_entries" int NOT NULL,
  "total_race_starts" int NOT NULL,
  "total_race_wins" int NOT NULL,
  "total_race_laps" int NOT NULL,
  "total_podiums" int NOT NULL,
  "total_podium_races" int NOT NULL,
  "total_pole_positions" int NOT NULL,
  "total_fastest_laps" int NOT NULL,
  "total_sprint_race_starts" int NOT NULL,
  "total_sprint_race_wins" int NOT NULL,
  PRIMARY KEY ("year", "tyre_manufacturer_id"),
  FOREIGN KEY ("tyre_manufacturer_id") REFERENCES "tyre_manufacturer" ("id"),
  FOREIGN KEY ("year") REFERENCES "season" ("year")
);
CREATE TABLE "season_driver" (
  "year" int NOT NULL,
  "driver_id" varchar(100) NOT NULL,
  "position_number" int,
  "position_text" varchar(4),
  "best_starting_grid_position" int,
  "best_race_result" int,
  "best_sprint_race_result" int,
  "total_race_entries" int NOT NULL,
  "total_race_starts" int NOT NULL,
  "total_race_wins" int NOT NULL,
  "total_race_laps" int NOT NULL,
  "total_podiums" int NOT NULL,
  "total_points" decimal(8, 2) NOT NULL,
  "total_pole_positions" int NOT NULL,
  "total_fastest_laps" int NOT NULL,
  "total_sprint_race_starts" int NOT NULL,
  "total_sprint_race_wins" int NOT NULL,
  "total_driver_of_the_day" int NOT NULL,
  "total_grand_slams" int NOT NULL,
  PRIMARY KEY ("year", "driver_id"),
  FOREIGN KEY ("driver_id") REFERENCES "driver" ("id"),
  FOREIGN KEY ("year") REFERENCES "season" ("year")
);
CREATE TABLE "season_driver_standing" (
  "year" int NOT NULL,
  "position_display_order" int NOT NULL,
  "position_number" int,
  "position_text" varchar(4) NOT NULL,
  "driver_id" varchar(100) NOT NULL,
  "points" decimal(8, 2) NOT NULL,
  "championship_won" boolean NOT NULL,
  PRIMARY KEY ("year", "position_display_order"),
  FOREIGN KEY ("driver_id") REFERENCES "driver" ("id"),
  FOREIGN KEY ("year") REFERENCES "season" ("year")
);
CREATE TABLE "season_constructor_standing" (
  "year" int NOT NULL,
  "position_display_order" int NOT NULL,
  "position_number" int,
  "position_text" varchar(4) NOT NULL,
  "constructor_id" varchar(100) NOT NULL,
  "engine_manufacturer_id" varchar(100) NOT NULL,
  "points" decimal(8, 2) NOT NULL,
  "championship_won" boolean NOT NULL,
  PRIMARY KEY ("year", "position_display_order"),
  FOREIGN KEY ("constructor_id") REFERENCES "constructor" ("id"),
  FOREIGN KEY ("engine_manufacturer_id") REFERENCES "engine_manufacturer" ("id"),
  FOREIGN KEY ("year") REFERENCES "season" ("year")
);
CREATE TABLE "race" (
  "id" int NOT NULL,
  "year" int NOT NULL,
  "round" int NOT NULL,
  "date" date NOT NULL,
  "time" varchar(5),
  "grand_prix_id" varchar(100) NOT NULL,
  "official_name" varchar(100) NOT NULL,
  "qualifying_format" varchar(20) NOT NULL,
  "sprint_qualifying_format" varchar(20),
  "circuit_id" varchar(100) NOT NULL,
  "circuit_type" varchar(6) NOT NULL,
  "direction" varchar(14) NOT NULL,
  "course_length" decimal(6, 3) NOT NULL,
  "turns" int NOT NULL,
  "laps" int NOT NULL,
  "distance" decimal(6, 3) NOT NULL,
  "scheduled_laps" int,
  "scheduled_distance" decimal(6, 3),
  "drivers_championship_decider" boolean NOT NULL,
  "constructors_championship_decider" boolean NOT NULL,
  "pre_qualifying_date" date,
  "pre_qualifying_time" varchar(5),
  "free_practice_1_date" date,
  "free_practice_1_time" varchar(5),
  "free_practice_2_date" date,
  "free_practice_2_time" varchar(5),
  "free_practice_3_date" date,
  "free_practice_3_time" varchar(5),
  "free_practice_4_date" date,
  "free_practice_4_time" varchar(5),
  "qualifying_1_date" date,
  "qualifying_1_time" varchar(5),
  "qualifying_2_date" date,
  "qualifying_2_time" varchar(5),
  "qualifying_date" date,
  "qualifying_time" varchar(5),
  "sprint_qualifying_date" date,
  "sprint_qualifying_time" varchar(5),
  "sprint_race_date" date,
  "sprint_race_time" varchar(5),
  "warming_up_date" date,
  "warming_up_time" varchar(5),
  PRIMARY KEY ("id"),
  UNIQUE ("year", "round"),
  FOREIGN KEY ("circuit_id") REFERENCES "circuit" ("id"),
  FOREIGN KEY ("grand_prix_id") REFERENCES "grand_prix" ("id"),
  FOREIGN KEY ("year") REFERENCES "season" ("year")
);
CREATE TABLE "race_data" (
  "race_id" int NOT NULL,
  "type" varchar(50) NOT NULL,
  "position_display_order" int NOT NULL,
  "position_number" int,
  "position_text" varchar(4) NOT NULL,
  "driver_number" varchar(3) NOT NULL,
  "driver_id" varchar(100) NOT NULL,
  "constructor_id" varchar(100) NOT NULL,
  "engine_manufacturer_id" varchar(100) NOT NULL,
  "tyre_manufacturer_id" varchar(100) NOT NULL,
  "practice_time" varchar(20),
  "practice_time_millis" int,
  "practice_gap" varchar(20),
  "practice_gap_millis" int,
  "practice_interval" varchar(20),
  "practice_interval_millis" int,
  "practice_laps" int,
  "qualifying_time" varchar(20),
  "qualifying_time_millis" int,
  "qualifying_q1" varchar(20),
  "qualifying_q1_millis" int,
  "qualifying_q2" varchar(20),
  "qualifying_q2_millis" int,
  "qualifying_q3" varchar(20),
  "qualifying_q3_millis" int,
  "qualifying_gap" varchar(20),
  "qualifying_gap_millis" int,
  "qualifying_interval" varchar(20),
  "qualifying_interval_millis" int,
  "qualifying_laps" int,
  "starting_grid_position_qualification_position_number" int,
  "starting_grid_position_qualification_position_text" varchar(4),
  "starting_grid_position_grid_penalty" varchar(20),
  "starting_grid_position_grid_penalty_positions" int,
  "starting_grid_position_time" varchar(20),
  "starting_grid_position_time_millis" int,
  "race_shared_car" boolean,
  "race_laps" int,
  "race_time" varchar(20),
  "race_time_millis" int,
  "race_time_penalty" varchar(20),
  "race_time_penalty_millis" int,
  "race_gap" varchar(20),
  "race_gap_millis" int,
  "race_gap_laps" int,
  "race_interval" varchar(20),
  "race_interval_millis" int,
  "race_reason_retired" varchar(100),
  "race_points" decimal(8, 2),
  "race_pole_position" boolean,
  "race_qualification_position_number" int,
  "race_qualification_position_text" varchar(4),
  "race_grid_position_number" int,
  "race_grid_position_text" varchar(2),
  "race_positions_gained" int,
  "race_pit_stops" int,
  "race_fastest_lap" boolean,
  "race_driver_of_the_day" boolean,
  "race_grand_slam" boolean,
  "fastest_lap_lap" int,
  "fastest_lap_time" varchar(20),
  "fastest_lap_time_millis" int,
  "fastest_lap_gap" varchar(20),
  "fastest_lap_gap_millis" int,
  "fastest_lap_interval" varchar(20),
  "fastest_lap_interval_millis" int,
  "pit_stop_stop" int,
  "pit_stop_lap" int,
  "pit_stop_time" varchar(20),
  "pit_stop_time_millis" int,
  "driver_of_the_day_percentage" decimal(4, 1),
  PRIMARY KEY ("race_id", "type", "position_display_order"),
  FOREIGN KEY ("constructor_id") REFERENCES "constructor" ("id"),
  FOREIGN KEY ("driver_id") REFERENCES "driver" ("id"),
  FOREIGN KEY ("engine_manufacturer_id") REFERENCES "engine_manufacturer" ("id"),
  FOREIGN KEY ("race_id") REFERENCES "race" ("id"),
  FOREIGN KEY ("tyre_manufacturer_id") REFERENCES "tyre_manufacturer" ("id")
);
CREATE TABLE "race_driver_standing" (
  "race_id" int NOT NULL,
  "position_display_order" int NOT NULL,
  "position_number" int,
  "position_text" varchar(4) NOT NULL,
  "driver_id" varchar(100) NOT NULL,
  "points" decimal(8, 2) NOT NULL,
  "positions_gained" int,
  "championship_won" boolean NOT NULL,
  PRIMARY KEY ("race_id", "position_display_order"),
  FOREIGN KEY ("driver_id") REFERENCES "driver" ("id"),
  FOREIGN KEY ("race_id") REFERENCES "race" ("id")
);
CREATE TABLE "race_constructor_standing" (
  "race_id" int NOT NULL,
  "position_display_order" int NOT NULL,
  "position_number" int,
  "position_text" varchar(4) NOT NULL,
  "constructor_id" varchar(100) NOT NULL,
  "engine_manufacturer_id" varchar(100) NOT NULL,
  "points" decimal(8, 2) NOT NULL,
  "positions_gained" int,
  "championship_won" boolean NOT NULL,
  PRIMARY KEY ("race_id", "position_display_order"),
  FOREIGN KEY ("constructor_id") REFERENCES "constructor" ("id"),
  FOREIGN KEY ("engine_manufacturer_id") REFERENCES "engine_manufacturer" ("id"),
  FOREIGN KEY ("race_id") REFERENCES "race" ("id")
);
