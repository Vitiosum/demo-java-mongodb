package cloud.clever.observatory;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.bson.Document;

/**
 * Turns the query bar's plain words into a real MongoDB filter document.
 *
 * <pre>
 *   type = planet             → { "type": "planet" }
 *   magnitude &lt; 2             → { "magnitude": { "$lt": 2.0 } }
 *   has moons                 → { "moons.0": { "$exists": true } }
 *   in constellation Orion    → { "$or": [ { "constellation": "Orion" },
 *                                          { "coordinates.constellation": "Orion" } ] }
 *   class = M                 → { "spectralClass": { "$regex": "^M" } }
 *   name ~ halley             → { "name": { "$regex": "halley", "$options": "i" } }
 * </pre>
 *
 * Clauses can be combined with "and". The filter is shown to the visitor as-is.
 */
final class SkyQuery {

    static final String HELP = "Try: type = planet, magnitude < 2, has moons, in constellation Orion.";

    private static final Map<String, String> TYPES = Map.ofEntries(
            Map.entry("star", "star"), Map.entry("stars", "star"),
            Map.entry("planet", "planet"), Map.entry("planets", "planet"),
            Map.entry("comet", "comet"), Map.entry("comets", "comet"),
            Map.entry("nebula", "nebula"), Map.entry("nebulae", "nebula"), Map.entry("nebulas", "nebula"),
            Map.entry("galaxy", "galaxy"), Map.entry("galaxies", "galaxy"),
            Map.entry("cluster", "cluster"), Map.entry("clusters", "cluster"),
            Map.entry("constellation", "constellation"), Map.entry("constellations", "constellation"));

    /** Friendly words for real field names. Any other field name is used as typed. */
    private static final Map<String, String> FIELDS = Map.of(
            "mag", "magnitude",
            "distance", "distanceLy",
            "period", "orbitalPeriodYears",
            "radius", "radiusKm",
            "showers", "meteorShowers",
            "spacecraft", "visitedBy",
            "discoverer", "discovery");

    private static final Map<String, String> OPERATORS =
            Map.of("<", "$lt", "<=", "$lte", ">", "$gt", ">=", "$gte", "=", "$eq");

    private static final Pattern TYPE = Pattern.compile("(?:type\\s*(?:=|is)\\s*)?(\\w+)");
    private static final Pattern HAS = Pattern.compile("has\\s+([a-z][\\w.]{0,40})");
    private static final Pattern COMPARE =
            Pattern.compile("([a-z][\\w.]{0,40})\\s*(<=|>=|<|>|=)\\s*(-?\\d+(?:\\.\\d+)?)");
    private static final Pattern IN = Pattern.compile("in\\s+(?:constellation\\s+|the\\s+)?([\\p{L} ]{3,30})");
    private static final Pattern SPECTRAL = Pattern.compile("(?:spectral\\s+)?class\\s*(?:=|is)?\\s*([obafgkm])");
    private static final Pattern NAME = Pattern.compile("name\\s*(?:~|contains|like)\\s*(.{1,40})");

    private SkyQuery() {}

    static Document parse(String text) {
        String query = text == null ? "" : text.strip();
        if (query.isEmpty()) {
            return new Document();
        }
        if (query.length() > 160) {
            throw new IllegalArgumentException("That query is too long. " + HELP);
        }
        List<Document> clauses = new ArrayList<>();
        for (String part : query.split("(?i)\\s+and\\s+")) {
            clauses.add(clause(part.strip()));
        }
        return clauses.size() == 1 ? clauses.getFirst() : new Document("$and", clauses);
    }

    private static Document clause(String original) {
        String text = original.toLowerCase(Locale.ROOT);
        Matcher m;

        if ((m = HAS.matcher(text)).matches()) {
            String field = m.group(1);
            if (field.equals("moons")) {
                // An array with at least one element: Mercury and Venus have "moons": []
                return new Document("moons.0", new Document("$exists", true));
            }
            return new Document(FIELDS.getOrDefault(field, camel(original, field)), new Document("$exists", true));
        }
        if ((m = COMPARE.matcher(text)).matches()) {
            String field = FIELDS.getOrDefault(m.group(1), camel(original, m.group(1)));
            double value = Double.parseDouble(m.group(3));
            return new Document(field, new Document(OPERATORS.get(m.group(2)), value));
        }
        if ((m = SPECTRAL.matcher(text)).matches()) {
            return new Document("spectralClass", new Document("$regex", "^" + m.group(1).toUpperCase(Locale.ROOT)));
        }
        if ((m = NAME.matcher(text)).matches()) {
            return new Document("name", new Document("$regex", escapeRegex(m.group(1).strip())).append("$options", "i"));
        }
        if ((m = IN.matcher(text)).matches()) {
            String constellation = titleCase(m.group(1).strip());
            return new Document("$or", List.of(
                    new Document("constellation", constellation),
                    new Document("coordinates.constellation", constellation)));
        }
        if (text.equals("discoveries") || text.equals("discovered")) {
            return new Document("discovery", new Document("$exists", true));
        }
        if ((m = TYPE.matcher(text)).matches() && TYPES.containsKey(m.group(1))) {
            return new Document("type", TYPES.get(m.group(1)));
        }
        throw new IllegalArgumentException("\"" + original + "\" is not a filter I know. " + HELP);
    }

    /** Matches the words literally: "m.42" must not mean "m, any character, 42". */
    private static String escapeRegex(String words) {
        return words.replaceAll("[\\\\^$.|?*+()\\[\\]{}]", "\\\\$0");
    }

    /** Keeps the visitor's own casing for field names such as distanceLy. */
    private static String camel(String original, String lowered) {
        int at = original.toLowerCase(Locale.ROOT).indexOf(lowered);
        return at < 0 ? lowered : original.substring(at, at + lowered.length());
    }

    private static String titleCase(String words) {
        if (words.equals("bootes")) {
            return "Boötes";
        }
        StringBuilder out = new StringBuilder();
        for (String word : words.split("\\s+")) {
            if (!out.isEmpty()) {
                out.append(' ');
            }
            out.append(Character.toUpperCase(word.charAt(0))).append(word.substring(1));
        }
        return out.toString();
    }
}
